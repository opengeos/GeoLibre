//! Shared registry for in-flight cancellable operations keyed by request ID.
//!
//! Replaces the duplicated `Arc<Mutex<HashMap<String, Cancel...>>>` maps across
//! `arcgis_http`, `plugin_http`, `remote_download`, and `chatgpt_auth`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Thread-safe registry of active in-flight items keyed by request ID.
pub(crate) struct InFlightRegistry<T> {
    entries: Arc<Mutex<HashMap<String, T>>>,
}

impl<T> Default for InFlightRegistry<T> {
    fn default() -> Self {
        Self {
            entries: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl<T> Clone for InFlightRegistry<T> {
    fn clone(&self) -> Self {
        Self {
            entries: Arc::clone(&self.entries),
        }
    }
}

#[allow(dead_code)]
impl<T> InFlightRegistry<T> {
    pub(crate) fn insert(&self, id: String, value: T) -> Option<T> {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(id, value)
    }

    pub(crate) fn try_insert_unique(&self, id: String, value: T) -> Result<(), T> {
        let mut map = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if map.contains_key(&id) {
            return Err(value);
        }
        map.insert(id, value);
        Ok(())
    }

    pub(crate) fn remove(&self, id: &str) -> Option<T> {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(id)
    }

    pub(crate) fn contains_key(&self, id: &str) -> bool {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains_key(id)
    }

    pub(crate) fn get_cloned(&self, id: &str) -> Option<T>
    where
        T: Clone,
    {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(id)
            .cloned()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_empty()
    }
}

pub(crate) type CancelCallback = Box<dyn Fn() + Send + Sync>;

/// Registry storing one-shot cancellation callbacks (`Box<dyn Fn() + Send + Sync>`).
#[derive(Default, Clone)]
pub(crate) struct CancelRegistry(InFlightRegistry<CancelCallback>);

#[allow(dead_code)]
impl CancelRegistry {
    /// Insert a cancellation callback for `id`, rejecting duplicate active IDs.
    pub(crate) fn try_register(&self, id: String, cancel: CancelCallback) -> Result<(), ()> {
        self.0.try_insert_unique(id, cancel).map_err(|_| ())
    }

    pub(crate) fn contains_key(&self, id: &str) -> bool {
        self.0.contains_key(id)
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Remove and invoke the cancellation callback for `id`, if registered.
    pub(crate) fn cancel(&self, id: &str) {
        if let Some(cancel) = self.0.remove(id) {
            cancel();
        }
    }

    /// Remove the entry without invoking its cancellation callback (used on clean finish).
    pub(crate) fn finish(&self, id: &str) {
        let _ = self.0.remove(id);
    }
}

/// RAII guard that cancels and unregisters `id` when dropped.
pub(crate) struct CancelGuard {
    registry: CancelRegistry,
    id: String,
}

impl CancelGuard {
    pub(crate) fn new(registry: CancelRegistry, id: String) -> Self {
        Self { registry, id }
    }
}

impl Drop for CancelGuard {
    fn drop(&mut self) {
        self.registry.cancel(&self.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn cancel_guard_runs_callback_once() {
        let reg = CancelRegistry::default();
        let called = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&called);
        reg.try_register(
            "req-1".into(),
            Box::new(move || flag.store(true, Ordering::SeqCst)),
        )
        .unwrap();
        assert!(reg.try_register("req-1".into(), Box::new(|| {})).is_err());
        {
            let _guard = CancelGuard::new(reg.clone(), "req-1".into());
        }
        assert!(called.load(Ordering::SeqCst));
        assert!(reg.is_empty());
    }
}
