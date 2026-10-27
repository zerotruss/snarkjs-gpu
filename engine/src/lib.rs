//! The GPU operations snarkjs needs, working directly on snarkjs / ffjavascript's byte formats so
//! no conversion is needed in JavaScript. One implementation serves both the Node addon (`node/`)
//! and the browser build (`web/`).
//!
//! - A G1 point is 64 bytes: x then y, 32 bytes each, in Montgomery form with R = 2^256; (0, 0) is
//!   the point at infinity. A G2 point is 128 bytes: x.a, x.b, y.a, y.b in the same form.
//! - A scalar is 32 bytes, plain little-endian.
//! - NTT data is n scalar-field elements of 32 bytes in snarkjs's Montgomery form. The transform
//!   is linear, so that form passes through unchanged.
//! - MSM results come back as plain little-endian coordinates (G1: x, y; G2: x.a, x.b, y.a, y.b),
//!   or empty for the point at infinity.
use std::{cell::RefCell, collections::HashMap, sync::Arc};
use zk_gpu::{
    gpu::Gpu,
    group::Group,
    msm::{xyzz_to_affine, xyzz_to_affine_g2, Msm},
    ntt::Ntt,
};

pub const SCALAR_BYTES: usize = 32;

pub use zk_gpu::group::Group as MsmGroup;

/// The GPU plus one reusable plan (buffers and pipelines) per input size.
// Arc, not Rc: on native targets the engine must be Send so Node can keep it behind a Mutex.
#[allow(clippy::arc_with_non_send_sync)]
pub struct Engine {
    gpu: Gpu,
    msm_plans: RefCell<HashMap<(Group, usize), Arc<Msm>>>,
    ntt_plans: RefCell<HashMap<u32, Arc<Ntt>>>,
}

/// Bytes per affine point in the snarkjs format.
pub fn point_bytes(group: Group) -> usize {
    group.affine_words() * 4
}

fn words(bytes: &[u8]) -> Vec<u32> {
    bytes.chunks_exact(4).map(|b| u32::from_le_bytes(b.try_into().unwrap())).collect()
}

fn le_bytes(limbs: [u64; 4]) -> Vec<u8> {
    limbs.iter().flat_map(|l| l.to_le_bytes()).collect()
}

/// Checks an MSM input and returns the number of points.
pub fn check_msm_input(group: Group, bases: &[u8], scalars: &[u8]) -> Result<usize, String> {
    let size = point_bytes(group);
    if bases.is_empty() || !bases.len().is_multiple_of(size) {
        return Err(format!("bases must be a non-empty multiple of {size} bytes"));
    }
    if scalars.len() != bases.len() / size * SCALAR_BYTES {
        return Err("scalars must be 32 bytes for each base point".into());
    }
    Ok(bases.len() / size)
}

/// Checks an NTT input and returns log2 of its length.
pub fn check_ntt_input(data: &[u8]) -> Result<u32, String> {
    let n = data.len() / SCALAR_BYTES;
    if !data.len().is_multiple_of(SCALAR_BYTES) || !n.is_power_of_two() || !(10..=27).contains(&n.trailing_zeros()) {
        return Err("data must be 2^10 to 2^27 elements of 32 bytes".into());
    }
    Ok(n.trailing_zeros())
}

#[allow(clippy::arc_with_non_send_sync)]
impl Engine {
    pub async fn new() -> Result<Self, String> {
        Ok(Self { gpu: Gpu::new_async().await?, msm_plans: Default::default(), ntt_plans: Default::default() })
    }

    /// Calls `log` with a message when the GPU reports an error that no call is waiting for.
    pub fn report_gpu_errors(&self, log: impl Fn(String) + Clone + Send + Sync + 'static) {
        self.gpu.report_errors(log);
    }

    pub fn adapter_name(&self) -> String {
        format!("{} ({:?})", self.gpu.adapter.name, self.gpu.adapter.backend)
    }

    /// Sum of scalars[i] * bases[i] in `group`.
    pub async fn msm(&self, group: Group, bases: &[u8], scalars: &[u8]) -> Result<Vec<u8>, String> {
        let n = check_msm_input(group, bases, scalars)?;
        let base_buffer = Msm::upload_bases_montgomery_256(&self.gpu, &words(bases));
        let scalar_buffer = self.gpu.buffer(&words(scalars));
        let plan = self
            .msm_plans
            .borrow_mut()
            .entry((group, n))
            .or_insert_with(|| Arc::new(Msm::for_group(&self.gpu, group, n, Msm::default_window(n), None)))
            .clone();
        let result = plan.run_yielding(&self.gpu, &base_buffer, &scalar_buffer).await;
        let words = self.gpu.try_read_async(&result, group.xyzz_words()).await?;
        Ok(match group {
            Group::G1 => xyzz_to_affine(&words).map_or(Vec::new(), |(x, y)| [le_bytes(x), le_bytes(y)].concat()),
            Group::G2 => xyzz_to_affine_g2(&words)
                .map_or(Vec::new(), |(x, y)| [x[0], x[1], y[0], y[1]].iter().flat_map(|c| le_bytes(*c)).collect()),
        })
    }

    /// Number-theoretic transform of `data` (the inverse includes the 1/n factor).
    pub async fn ntt(&self, data: &[u8], inverse: bool) -> Result<Vec<u8>, String> {
        let log_n = check_ntt_input(data)?;
        let buffer = self.gpu.buffer(&words(data));
        let plan =
            self.ntt_plans.borrow_mut().entry(log_n).or_insert_with(|| Arc::new(Ntt::new(&self.gpu, log_n))).clone();
        if inverse {
            plan.inverse(&self.gpu, &buffer);
        } else {
            plan.forward(&self.gpu, &buffer);
        }
        let out = self.gpu.try_read_async(&buffer, data.len() / 4).await?;
        Ok(out.iter().flat_map(|w| w.to_le_bytes()).collect())
    }
}
