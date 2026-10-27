//! Browser build: the GPU operations of `zk-gpu-engine` on WebGPU, exposed to JavaScript with
//! wasm-bindgen. Byte formats are described in `zk-gpu-engine`. Calls must not overlap on one
//! `GpuZk` (the JavaScript wrapper in src/browser.mjs queues them).
use wasm_bindgen::prelude::*;
use zk_gpu_engine::{Engine, MsmGroup};

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn error(message: &str);
}

#[wasm_bindgen]
pub struct GpuZk {
    engine: Engine,
}

fn failure(reason: String) -> JsError {
    JsError::new(&reason)
}

#[wasm_bindgen]
impl GpuZk {
    /// Opens the GPU. Fails if the browser has no WebGPU.
    pub async fn create() -> Result<GpuZk, JsError> {
        console_error_panic_hook::set_once(); // Rust panics show their message in the console
        let engine = Engine::new().await.map_err(failure)?;
        engine.report_gpu_errors(|message| error(&message));
        Ok(GpuZk { engine })
    }

    pub fn adapter(&self) -> String {
        self.engine.adapter_name()
    }

    #[wasm_bindgen(js_name = msmG1)]
    pub async fn msm_g1(&self, bases: Vec<u8>, scalars: Vec<u8>) -> Result<Vec<u8>, JsError> {
        self.engine.msm(MsmGroup::G1, &bases, &scalars).await.map_err(failure)
    }

    #[wasm_bindgen(js_name = msmG2)]
    pub async fn msm_g2(&self, bases: Vec<u8>, scalars: Vec<u8>) -> Result<Vec<u8>, JsError> {
        self.engine.msm(MsmGroup::G2, &bases, &scalars).await.map_err(failure)
    }

    pub async fn ntt(&self, data: Vec<u8>, inverse: bool) -> Result<Vec<u8>, JsError> {
        self.engine.ntt(&data, inverse).await.map_err(failure)
    }
}
