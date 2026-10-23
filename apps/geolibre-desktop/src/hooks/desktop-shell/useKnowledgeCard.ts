import type { MapEngine } from "@geolibre/map";
import { useCallback, useState, type RefObject } from "react";
import type { KnowledgePlace } from "../../components/layout/KnowledgeCardPanel";
import { hasKnowledgeCardConsent, recordKnowledgeCardConsent } from "../../lib/knowledge-consent";

/**
 * State and handlers for the Wikipedia knowledge card and its consent notice.
 *
 * @param mapControllerRef - The primary map engine, used to fly to a place.
 * @returns The open place, the pending consent state, and their handlers.
 */
export function useKnowledgeCard(mapControllerRef: RefObject<MapEngine | null>) {
  // The place shown in the Wikipedia knowledge card, or null when it is closed.
  // `pendingKnowledgePlace` holds the target while the one-time consent notice
  // is open, so it can be applied only after the user acknowledges it.
  const [knowledgePlace, setKnowledgePlace] = useState<KnowledgePlace | null>(null);
  const [pendingKnowledgePlace, setPendingKnowledgePlace] = useState<KnowledgePlace | null>(null);
  const [knowledgeNoticeOpen, setKnowledgeNoticeOpen] = useState(false);
  // Open a knowledge card for a clicked point, gating the first lookup behind a
  // one-time privacy notice since it sends the coordinate to Wikipedia.
  const handleExplorePlace = useCallback((lat: number, lng: number) => {
    if (hasKnowledgeCardConsent()) {
      setKnowledgePlace({ lat, lng });
    } else {
      setPendingKnowledgePlace({ lat, lng });
      setKnowledgeNoticeOpen(true);
    }
  }, []);
  const confirmKnowledgeConsent = useCallback(() => {
    recordKnowledgeCardConsent();
    setKnowledgeNoticeOpen(false);
    setKnowledgePlace(pendingKnowledgePlace);
    setPendingKnowledgePlace(null);
  }, [pendingKnowledgePlace]);
  // Stable identity (mapControllerRef is a ref) so the card's openNearby
  // useCallback, which depends on this, keeps its memoization across renders.
  const handleKnowledgeFlyTo = useCallback(
    (lat: number, lon: number) => {
      mapControllerRef.current?.flyTo({
        center: [lon, lat],
        zoom: Math.max(mapControllerRef.current?.readView().zoom ?? 12, 14),
      });
    },
    [mapControllerRef],
  );
  return {
    knowledgePlace,
    setKnowledgePlace,
    setPendingKnowledgePlace,
    knowledgeNoticeOpen,
    setKnowledgeNoticeOpen,
    handleExplorePlace,
    confirmKnowledgeConsent,
    handleKnowledgeFlyTo,
  };
}
