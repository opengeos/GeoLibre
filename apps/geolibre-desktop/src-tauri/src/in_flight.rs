//! Shared registry for in-flight cancellable operations keyed by request ID.
//!
//! Replaces the duplicated `Arc<Mutex<HashMap<String, Cancel...>>>` maps across
//! `arcgis_http`, `plugin_http`, `remote_download`, and `chatgpt_auth`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
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

impl<T> InFlightRegistry<T> {
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

    #[cfg(test)]
    pub(crate) fn is_empty(&self) -> bool {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_empty()
    }
}

pub(crate) type CancelCallback = Box<dyn Fn() + Send + Sync>;

struct CancelEntry {
    token: u64,
    callback: CancelCallback,
}

static NEXT_CANCEL_TOKEN: AtomicU64 = AtomicU64::new(1);

/// Registry storing one-shot cancellation callbacks (`Box<dyn Fn() + Send + Sync>`),
/// tagged with a monotonic generation token so a dropping guard can never cancel
/// a later request that reused the same ID.
#[derive(Default, Clone)]
pub(crate) struct CancelRegistry(InFlightRegistry<CancelEntry>);

impl CancelRegistry {
    /// Insert a cancellation callback for `id`, rejecting duplicate active IDs.
    #[cfg(test)]
    pub(crate) fn try_register(
        &self,
        id: String,
        cancel: CancelCallback,
    ) -> Result<CancelGuard, ()> {
        let token = NEXT_CANCEL_TOKEN.fetch_add(1, Ordering::Relaxed);
        self.0
            .try_insert_unique(
                id.clone(),
                CancelEntry {
                    token,
                    callback: cancel,
                },
            )
            .map_err(|_| ())?;
        Ok(CancelGuard {
            registry: self.clone(),
            id,
            token,
        })
    }

    /// Atomically check uniqueness of `id`, invoke `create` while holding the
    /// registry lock so duplicate IDs can never spawn concurrently, and return
    /// both the created value and a generation-scoped [`CancelGuard`].
    pub(crate) fn try_register_with<T>(
        &self,
        id: String,
        create: impl FnOnce() -> (T, CancelCallback),
    ) -> Result<(T, CancelGuard), ()> {
        let mut map = self
            .0
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if map.contains_key(&id) {
            return Err(());
        }
        let token = NEXT_CANCEL_TOKEN.fetch_add(1, Ordering::Relaxed);
        let (value, callback) = create();
        map.insert(id.clone(), CancelEntry { token, callback });
        Ok((
            value,
            CancelGuard {
                registry: self.clone(),
                id,
                token,
            },
        ))
    }

    pub(crate) fn contains_key(&self, id: &str) -> bool {
        self.0.contains_key(id)
    }

    #[cfg(test)]
    pub(crate) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Remove and invoke the cancellation callback for `id`, if registered.
    pub(crate) fn cancel(&self, id: &str) {
        if let Some(entry) = self.0.remove(id) {
            (entry.callback)();
        }
    }

    /// Remove and invoke the cancellation callback only if the entry still
    /// matches `token`, preventing an old guard from cancelling a reused ID.
    fn cancel_if_token(&self, id: &str, token: u64) {
        let removed = {
            let mut map = self
                .0
                .entries
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if map.get(id).is_some_and(|entry| entry.token == token) {
                map.remove(id)
            } else {
                None
            }
        };
        if let Some(entry) = removed {
            (entry.callback)();
        }
    }
}

/// RAII guard that cancels and unregisters only its own registration when dropped.
pub(crate) struct CancelGuard {
    registry: CancelRegistry,
    id: String,
    token: u64,
}

impl Drop for CancelGuard {
    fn drop(&mut self) {
        self.registry.cancel_if_token(&self.id, self.token);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn cancel_guard_runs_callback_once() {
        let reg = CancelRegistry::default();
        let called = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&called);
        let guard = reg
            .try_register(
                "req-1".into(),
                Box::new(move || flag.store(true, Ordering::SeqCst)),
            )
            .unwrap();
        assert!(reg.try_register("req-1".into(), Box::new(|| {})).is_err());
        drop(guard);
        assert!(called.load(Ordering::SeqCst));
        assert!(reg.is_empty());
    }

    #[test]
    fn stale_guard_does_not_cancel_reused_id() {
        let reg = CancelRegistry::default();
        let first_called = Arc::new(AtomicBool::new(false));
        let f1 = Arc::clone(&first_called);
        let guard1 = reg
            .try_register(
                "dup".into(),
                Box::new(move || f1.store(true, Ordering::SeqCst)),
            )
            .unwrap();
        // External cancel removes request 1 before guard1 drops.
        reg.cancel("dup");
        assert!(first_called.load(Ordering::SeqCst));

        // Request 2 reuses the same ID before guard1 drops.
        let second_called = Arc::new(AtomicBool::new(false));
        let f2 = Arc::clone(&second_called);
        let guard2 = reg
            .try_register(
                "dup".into(),
                Box::new(move || f2.store(true, Ordering::SeqCst)),
            )
            .unwrap();

        drop(guard1);
        assert!(
            !second_called.load(Ordering::SeqCst),
            "stale guard must not cancel a newer registration reusing the same ID"
        );
        assert!(reg.contains_key("dup"));

        drop(guard2);
        assert!(second_called.load(Ordering::SeqCst));
        assert!(reg.is_empty());
    }
}
