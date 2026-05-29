declare module "@google/earthengine" {
  const earthEngine: {
    apiclient?: {
      ensureAuthLibLoaded?: (callback: () => void) => void;
    };
    data?: {
      authenticateViaOauth?: (
        clientId: string,
        success: () => void,
        error?: (error: unknown) => void,
        extraScopes?: unknown,
        onImmediateFailed?: () => void,
      ) => void;
      authenticateViaPopup?: (
        success?: () => void,
        error?: (error: unknown) => void,
      ) => void;
      getAuthToken?: () => string | null | undefined;
    };
  };

  export default earthEngine;
}
