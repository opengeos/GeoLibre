/**
 * Martin (PostGIS vector tile server) connection state.
 *
 * This lives in the Add Data dialog shell rather than the PostgreSQL source
 * component so the running server survives the source unmounting/remounting:
 * once a layer has been added the server is kept alive across dialog reopens,
 * matching the original AddDataDialog behavior.
 */

import { useRef, useState } from "react";
import {
  stopMartinServer,
  type MartinServerInfo,
  type MartinSourceSummary,
} from "../../../lib/martin";

export interface MartinConnection {
  server: MartinServerInfo | null;
  setServer: (server: MartinServerInfo | null) => void;
  sources: MartinSourceSummary[];
  setSources: (sources: MartinSourceSummary[]) => void;
  selectedSourceId: string;
  setSelectedSourceId: (id: string) => void;
  status: string | null;
  setStatus: (status: string | null) => void;
  /** Set once a layer has been added so the server is kept running. */
  layerAddedRef: React.MutableRefObject<boolean>;
  /** Reset connection state when the PostgreSQL source opens. */
  resetOnOpen: () => void;
  /** Stop and clear the server unless a layer was already added. */
  stopTransient: () => void;
}

export function useMartinConnection(): MartinConnection {
  const [server, setServer] = useState<MartinServerInfo | null>(null);
  const [sources, setSources] = useState<MartinSourceSummary[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const layerAddedRef = useRef(false);

  const resetOnOpen = () => {
    if (!server) layerAddedRef.current = false;
    if (!layerAddedRef.current) {
      setServer(null);
      setSources([]);
      setSelectedSourceId("");
      setStatus(null);
    }
  };

  const stopTransient = () => {
    if (!server || layerAddedRef.current) return;
    void stopMartinServer();
    setServer(null);
    setSources([]);
    setSelectedSourceId("");
    setStatus(null);
  };

  return {
    server,
    setServer,
    sources,
    setSources,
    selectedSourceId,
    setSelectedSourceId,
    status,
    setStatus,
    layerAddedRef,
    resetOnOpen,
    stopTransient,
  };
}
