interface GalleryAutoLoadOptions {
  root: Element;
  sentinel: Element;
  generation: number;
  currentGeneration: () => number;
  isLoading: () => boolean;
  onLoad: () => void;
}

/** Observe the end of a gallery while rejecting callbacks from an old reload. */
export function observeGalleryEnd({
  root,
  sentinel,
  generation,
  currentGeneration,
  isLoading,
  onLoad,
}: GalleryAutoLoadOptions): () => void {
  const observer = new IntersectionObserver(
    ([entry]) => {
      if (!entry?.isIntersecting || generation !== currentGeneration() || isLoading()) {
        return;
      }
      observer.unobserve(sentinel);
      onLoad();
    },
    { root, rootMargin: "0px 0px 300px 0px" },
  );
  observer.observe(sentinel);
  return () => observer.disconnect();
}
