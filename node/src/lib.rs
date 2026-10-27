//! Node.js addon: the GPU operations of `zk-gpu-engine` (G1 and G2 multi-scalar multiplication
//! and the number-theoretic transform) with the byte formats described there. Work runs on the
//! libuv thread pool, so the JavaScript thread stays free.
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::sync::{Mutex, OnceLock};
use zk_gpu_engine::{check_msm_input, check_ntt_input, Engine, MsmGroup};

static ENGINE: OnceLock<std::result::Result<Mutex<Engine>, String>> = OnceLock::new();

fn engine() -> Result<&'static Mutex<Engine>> {
    ENGINE
        .get_or_init(|| pollster::block_on(Engine::new()).map(Mutex::new))
        .as_ref()
        .map_err(|e| Error::from_reason(e.clone()))
}

fn failed(reason: String) -> Error {
    Error::from_reason(reason)
}

/// Name of the GPU in use, or an error saying why there is none.
#[napi]
pub fn gpu_name() -> Result<String> {
    Ok(engine()?.lock().unwrap().adapter_name())
}

pub enum Job {
    Msm { group: MsmGroup, bases: Vec<u8>, scalars: Vec<u8> },
    Ntt { inverse: bool, data: Vec<u8> },
}

pub struct GpuTask(Job);

impl Task for GpuTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Vec<u8>> {
        let engine = engine()?.lock().unwrap();
        match &self.0 {
            Job::Msm { group, bases, scalars } => pollster::block_on(engine.msm(*group, bases, scalars)),
            Job::Ntt { inverse, data } => pollster::block_on(engine.ntt(data, *inverse)),
        }
        .map_err(failed)
    }

    fn resolve(&mut self, _env: Env, output: Vec<u8>) -> Result<Buffer> {
        Ok(output.into())
    }
}

fn msm(group: MsmGroup, bases: Uint8Array, scalars: Uint8Array) -> Result<AsyncTask<GpuTask>> {
    check_msm_input(group, &bases, &scalars).map_err(failed)?;
    engine()?; // fail now, not on the worker thread, if there is no GPU
    Ok(AsyncTask::new(GpuTask(Job::Msm { group, bases: bases.to_vec(), scalars: scalars.to_vec() })))
}

/// Sum of scalars[i] * bases[i] in G1: 64-byte points in, 64 plain little-endian bytes out
/// (x then y), or an empty buffer for the point at infinity.
#[napi]
pub fn msm_g1(bases: Uint8Array, scalars: Uint8Array) -> Result<AsyncTask<GpuTask>> {
    msm(MsmGroup::G1, bases, scalars)
}

/// The same in G2: 128-byte points in, 128 plain little-endian bytes out (x.a, x.b, y.a, y.b).
#[napi]
pub fn msm_g2(bases: Uint8Array, scalars: Uint8Array) -> Result<AsyncTask<GpuTask>> {
    msm(MsmGroup::G2, bases, scalars)
}

/// Number-theoretic transform of 2^10 to 2^27 elements of 32 bytes. The inverse includes 1/n.
#[napi]
pub fn ntt(data: Uint8Array, inverse: bool) -> Result<AsyncTask<GpuTask>> {
    check_ntt_input(&data).map_err(failed)?;
    engine()?;
    Ok(AsyncTask::new(GpuTask(Job::Ntt { inverse, data: data.to_vec() })))
}
