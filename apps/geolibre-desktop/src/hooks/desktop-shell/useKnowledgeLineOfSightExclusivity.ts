import { useEffect } from "react";
import type { KnowledgePlace } from "../../components/layout/KnowledgeCardPanel";
import { useLineOfSightTool } from "../../lib/line-of-sight-store";

/**
 * Keep the Line of Sight panel and the knowledge card mutually exclusive.
 *
 * Both share the map's bottom corner, so opening either closes the other
 * rather than stacking them: a new Line of Sight request closes the card, and
 * showing a place in the card closes Line of Sight.
 *
 * Args:
 *   knowledgePlace: The place the knowledge card shows, or null when closed.
 *   setKnowledgePlace: Sets (or with null, closes) the knowledge card's place.
 */
export function useKnowledgeLineOfSightExclusivity(
  knowledgePlace: KnowledgePlace | null,
  setKnowledgePlace: (place: KnowledgePlace | null) => void,
): void {
  const lineOfSightRequest = useLineOfSightTool((s) => s.request);
  useEffect(() => {
    if (lineOfSightRequest > 0) setKnowledgePlace(null);
  }, [lineOfSightRequest, setKnowledgePlace]);
  useEffect(() => {
    if (knowledgePlace) useLineOfSightTool.getState().closeLineOfSight();
  }, [knowledgePlace]);
}
