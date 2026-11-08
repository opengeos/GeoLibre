"""Tests for docker/deployment_policy.py, the deployment.json builder."""

import importlib.util
import json
import os
import stat
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures" / "deployment-policy"
LABEL = "GEOLIBRE_DEPLOYMENT_FILE"

_spec = importlib.util.spec_from_file_location(
    "deployment_policy", ROOT / "docker" / "deployment_policy.py"
)
dp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(dp)


def load_fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def error_of(call, *args):
    with pytest.raises(SystemExit) as raised:
        call(*args)
    return str(raised.value)


@pytest.mark.parametrize("name", ["good/minimal.json", "good/full.json"])
def test_good_fixtures_round_trip(name):
    doc = load_fixture(name)
    expected = {k: v for k, v in doc.items() if k != "$schema"}
    assert dp.validate_policy(doc, LABEL) == expected


def test_schema_key_is_accepted_and_dropped():
    assert dp.validate_policy({"$schema": "x", "version": 1}, LABEL) == {"version": 1}


def bad_cases():
    text = (FIXTURES / "bad-cases.json").read_text(encoding="utf-8")
    return json.loads(text)


@pytest.mark.parametrize("name", sorted(bad_cases()))
def test_bad_cases_fail_with_expected_error(name):
    case = bad_cases()[name]
    text = json.dumps(case["input"]).replace('"__UNSAFE__"', "9007199254740993")
    message = error_of(dp.validate_policy, json.loads(text), LABEL)
    assert message.startswith(f"ERROR: {LABEL}")
    assert case["container"] in message


def test_python_constants_match_schema():
    schema = json.loads((ROOT / "schema" / "deployment.schema.json").read_text(encoding="utf-8"))
    props = schema["properties"]
    assert set(props) == {"$schema", "version", *dp.SECTION_KEYS}
    for section, keys in dp.SECTION_KEYS.items():
        if keys is not None:
            assert tuple(props[section]["properties"]) == keys, section
    assert tuple(props["capabilities"]["items"]["enum"]) == dp.CAPABILITIES
    assert tuple(props["interface"]["properties"]["level"]["enum"]) == dp.EXPERIENCE_LEVELS
    entry = props["services"]["properties"]["catalog"]["items"]
    assert tuple(entry["properties"]) == dp.CATALOG_ENTRY_KEYS
    assert tuple(entry["properties"]["kind"]["enum"]) == dp.SERVICE_KINDS
    assert props["branding"]["properties"]["appName"]["maxLength"] == dp.APP_NAME_MAX
    assert props["osm"]["properties"]["overpassUrl"]["pattern"] == dp.OVERPASS_URL_PATTERN


@pytest.mark.parametrize("whitespace", [" ", "\t", "\ufeff", "\u00a0", "\u3000"])
def test_nonblank_fields_reject_js_trim_whitespace(whitespace):
    for section, field in [("plugins", "openPanel"), ("plugins", "registryUrl"), ("ai", "model")]:
        doc = {"version": 1, section: {field: whitespace}}
        msg = error_of(dp.validate_policy, doc, LABEL)
        assert f"{section}.{field} must be a nonblank string" in msg


def write_file(tmp_path, doc):
    path = tmp_path / "deployment.json"
    path.write_text(json.dumps(doc), encoding="utf-8")
    return str(path)


def test_no_input_gives_empty_policy():
    assert dp.build_policy({}) == ({"version": 1}, [])


def test_env_overrides_file_with_one_log_line(tmp_path):
    path = write_file(tmp_path, {"version": 1, "capabilities": ["data:add"]})
    policy, logs = dp.build_policy(
        {"GEOLIBRE_DEPLOYMENT_FILE": path, "GEOLIBRE_CAPABILITIES": "export:data"}
    )
    assert policy["capabilities"] == ["export:data"]
    overrides = [line for line in logs if " from GEOLIBRE_" in line]
    assert overrides == [
        "Deployment policy: capabilities from GEOLIBRE_CAPABILITIES = export:data"
        " (overrides GEOLIBRE_DEPLOYMENT_FILE)"
    ]


def test_blank_env_leaves_file_value(tmp_path):
    path = write_file(tmp_path, {"version": 1, "capabilities": ["data:add"]})
    policy, logs = dp.build_policy(
        {"GEOLIBRE_DEPLOYMENT_FILE": path, "GEOLIBRE_CAPABILITIES": "   "}
    )
    assert policy["capabilities"] == ["data:add"]
    assert not [line for line in logs if " from GEOLIBRE_" in line]


def test_capabilities_env_forms():
    assert dp.parse_capabilities_env("none") == []
    assert dp.parse_capabilities_env("data:add, data:add ,export:data") == [
        "data:add",
        "export:data",
    ]
    assert "Accepted values: project:edit" in error_of(dp.parse_capabilities_env, "bogus")
    assert "must list capabilities" in error_of(dp.parse_capabilities_env, ",")


def test_embed_origins_deduped_and_normalized():
    policy, _ = dp.build_policy({"GEOLIBRE_EMBED_ORIGINS": "https://a.example https://a.example/x"})
    assert policy["sharing"]["embedOrigins"] == ["https://a.example"]


def test_app_name_truncated_with_log():
    policy, logs = dp.build_policy({"GEOLIBRE_APP_NAME": "x" * 70})
    assert policy["branding"]["appName"] == "x" * 60
    assert any("truncated" in line for line in logs)


def test_ai_model_precedence(tmp_path):
    path = write_file(tmp_path, {"version": 1, "ai": {"enabled": True, "model": "from-file"}})
    base = {"GEOLIBRE_DEPLOYMENT_FILE": path, "GEOLIBRE_AI_URL": "/ai"}
    policy, _ = dp.build_policy(base)
    assert policy["ai"] == {"enabled": True, "model": "from-file"}
    policy, _ = dp.build_policy({**base, "GEOLIBRE_AI_MODEL": "m"})
    assert policy["ai"]["model"] == "m"


def test_ai_enabled_without_proxy_env_fails(tmp_path):
    path = write_file(tmp_path, {"version": 1, "ai": {"enabled": True}})
    message = error_of(dp.build_policy, {"GEOLIBRE_DEPLOYMENT_FILE": path})
    assert "ai.enabled is true, but the AI proxy is not configured" in message


def test_geolens_bare_host_gets_https():
    policy, _ = dp.build_policy({"GEOLIBRE_GEOLENS_URL": "catalog.example.com"})
    assert policy["geolens"]["url"] == "https://catalog.example.com"


def test_overpass_url_env_sets_policy_field(tmp_path):
    url = "https://overpass.example.com/api/interpreter"
    policy, logs = dp.build_policy({"GEOLIBRE_OVERPASS_URL": f"  {url}  "})
    assert policy["osm"] == {"overpassUrl": url}
    assert any(f"osm.overpassUrl from GEOLIBRE_OVERPASS_URL = {url}" in line for line in logs)

    path = write_file(tmp_path, {"version": 1, "osm": {"overpassUrl": "https://a.example/i"}})
    policy, logs = dp.build_policy({"GEOLIBRE_DEPLOYMENT_FILE": path, "GEOLIBRE_OVERPASS_URL": url})
    assert policy["osm"]["overpassUrl"] == url
    assert any(line.endswith(dp.OVERRIDE_SUFFIX) for line in logs)


def test_overpass_url_allows_plain_http_only_on_loopback():
    url = "http://localhost:12345/api/interpreter"
    assert dp.normalize_overpass_url(url) == url
    assert "must be a https:// URL" in error_of(
        dp.normalize_overpass_url, "http://overpass.example.com/api/interpreter"
    )


@pytest.mark.parametrize(
    "value, problem",
    [
        ("https://overpass.example.com/api/interpreter?key=x", "query parameters"),
        ("https://overpass.example.com/api/interpreter#x", "query parameters"),
        ("https://user:pw@overpass.example.com/api/interpreter", "credentials"),
        ("https://overpass.example.com/api interpreter", "whitespace"),
        ("overpass.example.com/api/interpreter", "must be a https:// URL"),
        ("HTTPS://overpass.example.com/api/interpreter", "lowercase https:// URL"),
        ("https://[bogus]/api/interpreter", "GEOLIBRE_OVERPASS_URL"),
        ("https://[2001:db8::1]/api/interpreter", "DNS or IPv4 host"),
        ("https://overpass.example.com:99999/api/interpreter", "port up to 65535"),
    ],
)
def test_overpass_url_env_rejects_bad_values(value, problem):
    message = error_of(dp.build_policy, {"GEOLIBRE_OVERPASS_URL": value})
    assert message.startswith("ERROR: GEOLIBRE_OVERPASS_URL")
    assert problem in message


def test_write_policy_is_atomic_and_world_readable(tmp_path):
    target = tmp_path / "deployment.json"
    dp.write_policy({"version": 1}, str(target))
    assert target.read_text(encoding="utf-8") == json.dumps({"version": 1}, indent=2) + "\n"
    assert stat.S_IMODE(os.stat(target).st_mode) == 0o644
    assert not (tmp_path / "deployment.json.tmp").exists()


@pytest.mark.parametrize("origin", ["https://a.example?x=1", "https://a.example#frag"])
def test_file_embed_origin_with_query_or_fragment_is_rejected(origin):
    doc = {"version": 1, "sharing": {"embedOrigins": [origin]}}
    assert "sharing.embedOrigins[0]" in error_of(dp.validate_policy, doc, LABEL)


@pytest.mark.parametrize(
    "origin", ["https://a.example:abc", "https://a.example:99999", "https://:443"]
)
def test_file_embed_origin_with_bad_port_or_host_is_rejected(origin):
    doc = {"version": 1, "sharing": {"embedOrigins": [origin]}}
    assert "sharing.embedOrigins[0]" in error_of(dp.validate_policy, doc, LABEL)


def test_file_embed_origin_with_port_and_ipv6_is_accepted():
    origins = ["http://localhost:8080", "https://[::1]:8443"]
    doc = {"version": 1, "sharing": {"embedOrigins": origins}}
    assert dp.validate_policy(doc, LABEL)["sharing"]["embedOrigins"] == origins


def test_unterminated_ipv6_origin_gets_a_path_qualified_error():
    doc = {"version": 1, "sharing": {"embedOrigins": ["https://[::1"]}}
    assert "sharing.embedOrigins[0]" in error_of(dp.validate_policy, doc, LABEL)


def test_services_file_with_bom_is_read(tmp_path):
    path = tmp_path / "services.json"
    body = {"services": [{"id": "a", "name": "A", "kind": "wms", "fields": {"url": "u"}}]}
    path.write_bytes(b"\xef\xbb\xbf" + json.dumps(body).encode())
    assert dp.read_services_file(str(path))[0]["id"] == "a"


def test_url_query_is_not_logged():
    policy, logs = dp.build_policy(
        {"GEOLIBRE_COLLAB_URL": "wss://relay.example.com/s?token=SECRET"}
    )
    assert policy["sharing"]["collabUrl"].endswith("token=SECRET")
    assert not any("SECRET" in line for line in logs)


@pytest.mark.parametrize("url", ["wss://[::1", "wss://[bogus]"])
def test_malformed_bracketed_host_is_a_clean_error(url):
    assert "GEOLIBRE_COLLAB_URL is not a valid URL" in error_of(dp.normalize_collab_url, url)
    doc = {"version": 1, "sharing": {"collabUrl": url}}
    assert "sharing.collabUrl is not a valid URL" in error_of(dp.validate_policy, doc, LABEL)


def test_embed_origins_env_is_deduplicated():
    assert dp.parse_embed_origins("https://a.example,https://a.example *") == [
        "https://a.example",
        "*",
    ]


@pytest.mark.parametrize(
    "url", ["wss://[bogus]?token=SECRET", "ftp://relay.example.com/?token=SECRET"]
)
def test_url_errors_do_not_echo_a_query_token(url):
    assert "SECRET" not in error_of(dp.normalize_collab_url, url)
    doc = {"version": 1, "sharing": {"collabUrl": url}}
    assert "SECRET" not in error_of(dp.validate_policy, doc, LABEL)


def test_whitespace_in_env_url_names_the_env_var():
    message = error_of(dp.normalize_share_url, "https://example.com/some path")
    assert message == "ERROR: GEOLIBRE_SHARE_URL must not contain whitespace."


def test_share_url_rejects_query_and_fragment():
    assert "must not include query parameters or a fragment" in error_of(
        dp.normalize_share_url, "https://share.example.com/?query=1"
    )
    assert "must not include query parameters or a fragment" in error_of(
        dp.normalize_share_url, "https://share.example.com/#frag"
    )
    for bare in ("https://share.example.com/?", "https://share.example.com/#"):
        assert "must not include query parameters or a fragment" in error_of(
            dp.normalize_share_url, bare
        )


@pytest.mark.parametrize("whitespace", ["\ufeff", "\u00a0", "\u3000"])
def test_service_entry_ids_and_names_use_js_trim(whitespace):
    def problem(kind, key):
        raise ValueError(f"{kind}:{key}")

    for key in ("id", "name"):
        entry = {"id": "a", "name": "A", "kind": "wms", "fields": {"url": "u"}}
        entry[key] = whitespace
        with pytest.raises(ValueError, match=f"nonblank:{key}"):
            dp.check_service_entry(entry, set(), problem)
    entry = {
        "id": f"{whitespace}a",
        "name": f"A{whitespace}",
        "kind": "wms",
        "fields": {"url": "u"},
    }
    service = dp.check_service_entry(entry, set(), problem)
    assert (service["id"], service["name"]) == ("a", "A")


@pytest.mark.parametrize("whitespace", ["\ufeff", "\u00a0", "\u3000"])
def test_ids_and_app_name_reject_js_trim_whitespace(whitespace):
    doc = {"version": 1, "plugins": {"allowed": [whitespace]}}
    assert "plugins.allowed[0] must be a nonblank string" in error_of(
        dp.validate_policy, doc, LABEL
    )
    doc = {"version": 1, "branding": {"appName": whitespace}}
    assert "branding.appName must be a nonblank string" in error_of(dp.validate_policy, doc, LABEL)
    policy = dp.validate_policy(
        {"version": 1, "plugins": {"allowed": [f"{whitespace}a{whitespace}"]}}, LABEL
    )
    assert policy["plugins"]["allowed"] == ["a"]
