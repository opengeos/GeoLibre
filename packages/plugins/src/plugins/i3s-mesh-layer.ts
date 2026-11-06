/**
 * The mesh layer GeoLibre draws ArcGIS I3S scene content with.
 *
 * deck.gl's `Tile3DLayer` draws I3S nodes with its own `MeshLayer`, which
 * shades them through luma.gl's PBR material module. Since GeoLibre moved to
 * deck.gl 9.4 / luma.gl 9.4 (#2395, 2026-09-15) that path draws nothing on
 * WebGL: the tiles load, are selected and their draw calls run, but every
 * fragment comes out transparent, so no I3S scene layer has rendered since
 * (GeoLibre 3.0.0 on deck.gl 9.3.11 drew them; 3.1.0 on 9.4.0 did not).
 *
 * This layer is deck.gl 9.3's I3S `MeshLayer` without the PBR module: it
 * shades with the `SimpleMeshLayer` lighting (phong) and samples the node's
 * base-colour texture, which luma.gl's `parsePBRMaterial` still decodes
 * (including compressed textures). I3S UV regions (texture atlases) are
 * applied in the vertex shader as before. `Tile3DLayer` uses it through
 * `_subLayerProps.mesh.type`.
 *
 * The class is built at runtime from the lazily loaded deck.gl and luma.gl
 * modules, so none of them enter the boot bundle.
 *
 * Adapted from @deck.gl/geo-layers 9.3.11 `mesh-layer` (MIT, vis.gl
 * contributors).
 */

/** Uniform block: whether picking uses per-vertex feature colours. */
const MESH_UNIFORM_BLOCK = `\
layout(std140) uniform meshUniforms {
  bool pickFeatureIds;
} mesh;
`;

/**
 * Vertex shader: deck.gl 9.3's I3S mesh shader with UV regions, picking by
 * per-vertex feature colour or (deck.gl 9.4) by instance id.
 */
const VERTEX_SHADER = `#version 300 es
#define SHADER_NAME i3s-mesh-layer-vs
in vec3 positions;
in vec3 normals;
in vec3 colors;
in vec2 texCoords;
in vec4 uvRegions;
in vec3 featureIdsPickingColors;
in vec4 instanceColors;
in vec3 instanceModelMatrixCol0;
in vec3 instanceModelMatrixCol1;
in vec3 instanceModelMatrixCol2;
out vec2 vTexCoord;
out vec3 cameraPosition;
out vec3 normals_commonspace;
out vec4 position_commonspace;
out vec4 vColor;
vec2 applyUVRegion(vec2 uv) {
#ifdef HAS_UV_REGIONS
  return fract(uv) * (uvRegions.zw - uvRegions.xy) + uvRegions.xy;
#else
  return uv;
#endif
}
void main(void) {
  vec2 uv = applyUVRegion(texCoords);
  geometry.uv = uv;
  if (mesh.pickFeatureIds) {
    geometry.pickingColor = featureIdsPickingColors;
  } else {
    geometry.pickingColor = picking_getPickingColorFromInstanceID();
  }
  mat3 instanceModelMatrix = mat3(instanceModelMatrixCol0, instanceModelMatrixCol1, instanceModelMatrixCol2);
  vTexCoord = uv;
  cameraPosition = project.cameraPosition;
  vColor = vec4(colors * instanceColors.rgb, instanceColors.a);
  vec3 projectedPosition = project_position(positions);
  position_commonspace = vec4(projectedPosition, 1.0);
  gl_Position = project_common_position_to_clipspace(position_commonspace);
  geometry.position = position_commonspace;
  normals_commonspace = project_normal(instanceModelMatrix * normals);
  geometry.normal = normals_commonspace;
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);
  DECKGL_FILTER_COLOR(vColor, geometry);
}
`;

/** Fragment shader: the mesh layer's non-PBR branch (texture or vertex colour, lit). */
const FRAGMENT_SHADER = `#version 300 es
#define SHADER_NAME i3s-mesh-layer-fs
precision highp float;
uniform sampler2D sampler;
in vec2 vTexCoord;
in vec3 cameraPosition;
in vec3 normals_commonspace;
in vec4 position_commonspace;
in vec4 vColor;
out vec4 fragColor;
void main(void) {
  geometry.uv = vTexCoord;
  vec3 normal;
  if (simpleMesh.flatShading) {
    normal = normalize(cross(dFdx(position_commonspace.xyz), dFdy(position_commonspace.xyz)));
  } else {
    normal = normals_commonspace;
  }
  vec4 color = simpleMesh.hasTexture ? texture(sampler, vTexCoord) : vColor;
  vec3 lightColor = lighting_getLightColor(color.rgb, cameraPosition, position_commonspace.xyz, normal);
  fragColor = vec4(lightColor, color.a * layer.opacity);
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
`;

/** The luma.gl pieces the layer needs, loaded with deck.gl. */
export interface I3sMeshLayerLuma {
  Model: new (device: unknown, props: Record<string, unknown>) => unknown;
  parsePBRMaterial: (...args: unknown[]) => {
    bindings: Record<string, unknown>;
    generatedTextures: { destroy(): void }[];
  };
}

type MeshAttributes = Record<string, { value: ArrayLike<number>; size: number } | undefined>;

/**
 * Give a mesh without vertex colours a white colour attribute, as deck.gl
 * does. It changes the mesh's own attribute object, in place.
 */
function ensureVertexColors(attributes: MeshAttributes): void {
  const positions = attributes.positions ?? attributes.POSITION;
  if (!positions || attributes.COLOR_0 || attributes.colors) return;
  const vertexCount = positions.value.length / positions.size;
  (attributes as Record<string, unknown>).colors = {
    size: 4,
    value: new Uint8Array(vertexCount * 4).fill(255),
    normalized: true,
  };
}

/**
 * Build the I3S mesh layer class on top of the given `SimpleMeshLayer`.
 *
 * @param SimpleMeshLayer - `@deck.gl/mesh-layers`' `SimpleMeshLayer`.
 * @param luma - luma.gl's `Model` and `parsePBRMaterial`.
 * @returns A layer class for `Tile3DLayer`'s `_subLayerProps.mesh.type`.
 */
export function createI3sMeshLayerClass(SimpleMeshLayer: unknown, luma: I3sMeshLayerLuma): unknown {
  const meshUniforms = {
    name: "mesh",
    vs: MESH_UNIFORM_BLOCK,
    fs: MESH_UNIFORM_BLOCK,
    uniformTypes: { pickFeatureIds: "f32" },
  };
  // deck.gl's layer classes are untyped here; the members used are the ones
  // deck.gl's own I3S mesh layer uses on SimpleMeshLayer.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const Base = SimpleMeshLayer as any;
  class I3sMeshLayer extends Base {
    getShaders() {
      const shaders = super.getShaders();
      return {
        ...shaders,
        vs: VERTEX_SHADER,
        fs: FRAGMENT_SHADER,
        modules: [...shaders.modules, meshUniforms],
      };
    }

    initializeState() {
      super.initializeState();
      if (this.props.featureIds) {
        this.getAttributeManager().add({
          featureIdsPickingColors: {
            type: "uint8",
            size: 3,
            noAlloc: true,
            update: this.calculateFeatureIdsPickingColors,
          },
        });
      }
    }

    updateState(params: any) {
      super.updateState(params);
      const { props, oldProps } = params;
      // A new mesh means a new model, which starts without the texture.
      if (props.pbrMaterial !== oldProps.pbrMaterial || props.mesh !== oldProps.mesh) {
        this.updateTexture(props.pbrMaterial);
      }
    }

    draw(opts: any) {
      const { model } = this.state;
      if (!model) return;
      model.shaderInputs.setProps({ mesh: { pickFeatureIds: Boolean(this.props.featureIds) } });
      super.draw(opts);
    }

    getModel(mesh: any) {
      const shaders = this.getShaders();
      ensureVertexColors(mesh.attributes);
      return new luma.Model(this.context.device, {
        ...shaders,
        id: this.props.id,
        geometry: mesh,
        bufferLayout: this.getAttributeManager().getBufferLayouts(),
        // luma.gl writes `#define NAME 0` for a 0, which `#ifdef` still takes,
        // so the define is left out for a mesh without UV regions.
        defines: {
          ...shaders.defines,
          ...(mesh.attributes.uvRegions ? { HAS_UV_REGIONS: 1 } : {}),
        },
        isInstanced: true,
      });
    }

    /** Bind the node's base-colour texture (decoded by luma.gl) as the mesh texture. */
    updateTexture(material: any) {
      const { model } = this.state;
      if (!model) return;
      this.releaseMaterialTextures();
      const parsed = material
        ? luma.parsePBRMaterial(
            this.context.device,
            material,
            {
              NORMAL: this.props.mesh.attributes.normals,
              TEXCOORD_0: this.props.mesh.attributes.texCoords,
            },
            { pbrDebug: false, lights: false, useTangents: false },
          )
        : null;
      this.setState({ parsedMaterial: parsed });
      const baseColor = parsed?.bindings.pbr_baseColorSampler;
      model.shaderInputs.setProps({
        simpleMesh: {
          sampler: baseColor || this.state.emptyTexture,
          hasTexture: Boolean(baseColor),
        },
      });
    }

    releaseMaterialTextures() {
      this.state.parsedMaterial?.generatedTextures.forEach((texture: { destroy(): void }) =>
        texture.destroy(),
      );
      this.setState({ parsedMaterial: null });
    }

    calculateFeatureIdsPickingColors(attribute: any) {
      const featureIds = this.props.featureIds as ArrayLike<number>;
      const value = new Uint8ClampedArray(featureIds.length * attribute.size);
      const pickingColor: number[] = [];
      for (let index = 0; index < featureIds.length; index++) {
        this.encodePickingColor(featureIds[index], pickingColor);
        value[index * 3] = pickingColor[0];
        value[index * 3 + 1] = pickingColor[1];
        value[index * 3 + 2] = pickingColor[2];
      }
      attribute.value = value;
    }

    finalizeState(context: any) {
      super.finalizeState(context);
      this.releaseMaterialTextures();
    }
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
  (I3sMeshLayer as unknown as { layerName: string }).layerName = "I3sMeshLayer";
  (I3sMeshLayer as unknown as { defaultProps: unknown }).defaultProps = {
    pbrMaterial: { type: "object", value: null },
    featureIds: { type: "array", value: null, optional: true },
  };
  return I3sMeshLayer;
}
