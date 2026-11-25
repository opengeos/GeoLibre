//! Prepared native extraction jobs bridge the interval between UI preparation
//! and worker startup. Cancellation uses the app's shared generation-safe
//! registry; bounded reservations and RAII cleanup own each job's lifetime.

use crate::in_flight::{CancelGuard, CancelRegistry};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

const MAX_JOBS: usize = 8;
const PREPARED_TTL: Duration = Duration::from_secs(60);

struct Job {
    cancelled: Arc<AtomicBool>,
    prepared: Instant,
    running: bool,
    guard: Option<CancelGuard>,
}

#[derive(Clone, Default)]
pub(crate) struct OfflineExtractionJobs {
    jobs: Arc<Mutex<HashMap<String, Job>>>,
    cancellation: CancelRegistry,
}

impl OfflineExtractionJobs {
    /// Reserve cancellation before dispatching an extraction. Unclaimed
    /// reservations expire; running workers retain their slots until dropped.
    pub fn prepare(&self) -> Result<String, String> {
        self.prepare_at(Instant::now())
    }

    fn prepare_at(&self, now: Instant) -> Result<String, String> {
        let mut jobs = self
            .jobs
            .lock()
            .map_err(|_| "Extraction jobs unavailable")?;
        jobs.retain(|_, job| job.running || now.duration_since(job.prepared) < PREPARED_TTL);
        if jobs.len() >= MAX_JOBS {
            return Err("Too many native extraction jobs; finish or cancel one first".into());
        }
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random).map_err(|e| e.to_string())?;
        let id = format!("extract-{:032x}", u128::from_le_bytes(random));
        let cancelled = Arc::new(AtomicBool::new(false));
        let flag = cancelled.clone();
        let (_, guard) = self
            .cancellation
            .try_register_with(id.clone(), || {
                ((), Box::new(move || flag.store(true, Ordering::Relaxed)))
            })
            .map_err(|_| "Could not allocate an extraction job")?;
        jobs.insert(
            id.clone(),
            Job {
                cancelled,
                prepared: now,
                running: false,
                guard: Some(guard),
            },
        );
        Ok(id)
    }

    /// Transfer one prepared reservation into exactly one running worker.
    pub fn claim(&self, id: &str) -> Result<OfflineExtractionJob, String> {
        if id.len() != 40 || !id.starts_with("extract-") {
            return Err("Invalid extraction job".into());
        }
        let mut jobs = self
            .jobs
            .lock()
            .map_err(|_| "Extraction jobs unavailable")?;
        let job = jobs
            .get_mut(id)
            .ok_or("Extraction job expired or canceled")?;
        if job.running {
            return Err("Extraction job already running".into());
        }
        if job.prepared.elapsed() >= PREPARED_TTL || job.cancelled.load(Ordering::Relaxed) {
            jobs.remove(id);
            return Err("Extraction job expired or canceled".into());
        }
        job.running = true;
        Ok(OfflineExtractionJob {
            id: id.to_string(),
            cancelled: job.cancelled.clone(),
            owner: self.clone(),
            _guard: job.guard.take(),
        })
    }

    /// Cancel a prepared or running job without waiting for the storage lock.
    pub fn cancel(&self, id: &str) -> Result<(), String> {
        self.cancellation.cancel(id);
        let mut jobs = self
            .jobs
            .lock()
            .map_err(|_| "Extraction jobs unavailable")?;
        if jobs.get(id).is_some_and(|job| !job.running) {
            jobs.remove(id);
        }
        Ok(())
    }
}

pub(crate) struct OfflineExtractionJob {
    id: String,
    pub cancelled: Arc<AtomicBool>,
    owner: OfflineExtractionJobs,
    _guard: Option<CancelGuard>,
}

impl Drop for OfflineExtractionJob {
    fn drop(&mut self) {
        // Release bookkeeping first; the shared cancellation guard then drops
        // independently and unregisters only this request's generation.
        if let Ok(mut jobs) = self.owner.jobs.lock() {
            jobs.remove(&self.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_before_start_cannot_be_lost_or_replayed() {
        let jobs = OfflineExtractionJobs::default();
        let id = jobs.prepare().unwrap();
        jobs.cancel(&id).unwrap();
        assert!(jobs.claim(&id).is_err());
        assert!(jobs.jobs.lock().unwrap().is_empty());
        assert!(!jobs.cancellation.contains_key(&id));
    }

    #[test]
    fn one_worker_owns_cancellation_and_cleanup() {
        let jobs = OfflineExtractionJobs::default();
        let id = jobs.prepare().unwrap();
        let worker = jobs.claim(&id).unwrap();
        assert!(jobs.claim(&id).is_err());
        assert!(!worker.cancelled.load(Ordering::Relaxed));
        jobs.cancel(&id).unwrap();
        assert!(worker.cancelled.load(Ordering::Relaxed));
        assert_eq!(jobs.jobs.lock().unwrap().len(), 1);
        drop(worker);
        assert!(jobs.jobs.lock().unwrap().is_empty());
        assert!(!jobs.cancellation.contains_key(&id));
    }

    #[test]
    fn running_and_prepared_jobs_are_bounded_but_abandoned_preparations_expire() {
        let jobs = OfflineExtractionJobs::default();
        let first = jobs.prepare().unwrap();
        let worker = jobs.claim(&first).unwrap();
        let abandoned: Vec<_> = (1..MAX_JOBS).map(|_| jobs.prepare().unwrap()).collect();
        assert!(jobs.prepare().is_err());
        let fresh = jobs.prepare_at(Instant::now() + PREPARED_TTL).unwrap();
        assert_eq!(jobs.jobs.lock().unwrap().len(), 2);
        assert!(!worker.cancelled.load(Ordering::Relaxed));
        for id in abandoned {
            assert!(!jobs.cancellation.contains_key(&id));
            assert!(jobs.claim(&id).is_err());
        }
        jobs.cancel(&fresh).unwrap();
        drop(worker);
        assert!(jobs.jobs.lock().unwrap().is_empty());
    }
}
