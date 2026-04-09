#[cfg(target_os = "windows")]
use crate::windows::{capture_monitor_rgba, crop_rgba_region, encode_png_rgba};
#[cfg(target_os = "windows")]
use image::ImageReader;
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::sync::Mutex;
use tauri::{command, State, Webview};

#[cfg(target_os = "windows")]
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Environment12, ICoreWebView2_17, COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_WRITE,
};
#[cfg(target_os = "windows")]
use windows_core::Interface;

#[derive(Default)]
pub struct CaptureWindowSourceState(pub Mutex<Option<CaptureWindowSource>>);

#[derive(Clone)]
pub struct CaptureWindowSource {
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize)]
pub struct CaptureWindowSourceInfo {
    pub width: u32,
    pub height: u32,
}

#[derive(Deserialize)]
pub struct CaptureWindowSourceMonitorInput {
    pub left: i32,
    pub top: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Deserialize)]
pub struct CaptureWindowSourceCropInput {
    pub left: u32,
    pub top: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize)]
pub struct CaptureWindowSourceCropPayload {
    pub width: u32,
    pub height: u32,
    pub png: Vec<u8>,
}

#[cfg(target_os = "windows")]
async fn create_shared_buffer(
    webview: Webview,
    data: &[u8],
    extra_data: &[u8],
    transfer_type: String,
) -> Result<(), String> {
    let (sender, receiver) = std::sync::mpsc::channel::<Result<(), String>>();
    let data_static: &'static [u8] = unsafe { std::mem::transmute(data) };
    let extra_data_static: &'static [u8] = unsafe { std::mem::transmute(extra_data) };

    let send_result = sender.clone();
    match webview.with_webview(move |webview| {
        let environment = webview.environment();

        let core_webview = match unsafe { webview.controller().CoreWebView2() } {
            Ok(core_webview) => core_webview,
            Err(error) => {
                send_result
                    .send(Err(format!(
                        "[create_capture_window_shared_buffer] Failed to get core webview: {:?}",
                        error
                    )))
                    .unwrap();
                return;
            }
        };

        let environment_12 = match environment.cast::<ICoreWebView2Environment12>() {
            Ok(environment) => environment,
            Err(error) => {
                send_result
                    .send(Err(format!(
                        "[create_capture_window_shared_buffer] Failed to cast environment: {:?}",
                        error
                    )))
                    .unwrap();
                return;
            }
        };

        let shared_buffer = match unsafe {
            environment_12.CreateSharedBuffer((data_static.len() + extra_data_static.len()) as u64)
        } {
            Ok(shared_buffer) => shared_buffer,
            Err(error) => {
                send_result
                    .send(Err(format!(
                        "[create_capture_window_shared_buffer] Failed to create shared buffer: {:?}",
                        error
                    )))
                    .unwrap();
                return;
            }
        };

        let mut shared_buffer_ptr: *mut u8 = std::ptr::null_mut();
        if let Err(error) = unsafe { shared_buffer.Buffer(&mut shared_buffer_ptr) } {
            send_result
                .send(Err(format!(
                    "[create_capture_window_shared_buffer] Failed to map shared buffer: {:?}",
                    error
                )))
                .unwrap();
            return;
        }

        unsafe {
            std::ptr::copy_nonoverlapping(data_static.as_ptr(), shared_buffer_ptr, data_static.len());
            std::ptr::copy_nonoverlapping(
                extra_data_static.as_ptr(),
                shared_buffer_ptr.add(data_static.len()),
                extra_data_static.len(),
            );
        }

        let webview_17 = match core_webview.cast::<ICoreWebView2_17>() {
            Ok(webview) => webview,
            Err(error) => {
                send_result
                    .send(Err(format!(
                        "[create_capture_window_shared_buffer] Failed to cast to ICoreWebView2_17: {:?}",
                        error
                    )))
                    .unwrap();
                return;
            }
        };

        let additional_data_string: Vec<u16> =
            format!("{{\"transfer_type\":\"{}\"}}", transfer_type)
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
        let additional_data = windows::core::PCWSTR::from_raw(additional_data_string.as_ptr());

        match unsafe {
            webview_17.PostSharedBufferToScript(
                &shared_buffer,
                COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_WRITE,
                additional_data,
            )
        } {
            Ok(_) => {
                send_result.send(Ok(())).unwrap();
            }
            Err(error) => {
                send_result
                    .send(Err(format!(
                        "[create_capture_window_shared_buffer] Failed to post shared buffer: {:?}",
                        error
                    )))
                    .unwrap();
            }
        }
    }) {
        Ok(_) => {}
        Err(error) => {
            sender
                .send(Err(format!(
                    "[create_capture_window_shared_buffer] Failed to access webview: {:?}",
                    error
                )))
                .unwrap();
        }
    }

    receiver.recv().map_err(|_| {
        "[create_capture_window_shared_buffer] Failed to receive result".to_string()
    })??;

    Ok(())
}

#[command]
pub fn set_capture_window_source_from_file(
    state: State<'_, CaptureWindowSourceState>,
    path: String,
) -> Result<CaptureWindowSourceInfo, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = state;
        let _ = path;
        Err("Shared buffer source is only supported on Windows".to_string())
    }

    #[cfg(target_os = "windows")]
    {
        let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
        let image = ImageReader::new(Cursor::new(bytes))
            .with_guessed_format()
            .map_err(|error| error.to_string())?
            .decode()
            .map_err(|error| error.to_string())?
            .to_rgba8();
        let (width, height) = image.dimensions();

        let mut guard = state
            .0
            .lock()
            .map_err(|_| "Failed to lock capture window source state".to_string())?;
        *guard = Some(CaptureWindowSource {
            rgba: image.into_raw(),
            width,
            height,
        });
        Ok(CaptureWindowSourceInfo { width, height })
    }
}

#[command]
pub fn set_capture_window_source_from_monitor(
    state: State<'_, CaptureWindowSourceState>,
    monitor: CaptureWindowSourceMonitorInput,
) -> Result<CaptureWindowSourceInfo, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = state;
        let _ = monitor;
        Err("Monitor capture source is only supported on Windows".to_string())
    }

    #[cfg(target_os = "windows")]
    {
        let (width, height, rgba) =
            capture_monitor_rgba(monitor.left, monitor.top, monitor.width, monitor.height)?;

        let mut guard = state
            .0
            .lock()
            .map_err(|_| "Failed to lock capture window source state".to_string())?;
        *guard = Some(CaptureWindowSource {
            rgba,
            width,
            height,
        });
        Ok(CaptureWindowSourceInfo { width, height })
    }
}

#[command]
pub async fn post_capture_window_source_shared_buffer(
    webview: Webview,
    state: State<'_, CaptureWindowSourceState>,
) -> Result<bool, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = webview;
        let _ = state;
        Ok(false)
    }

    #[cfg(target_os = "windows")]
    {
        let (rgba, width, height) = {
            let capture = state
                .0
                .lock()
                .map_err(|_| "Failed to lock capture window source state".to_string())?;
            let Some(source) = capture.as_ref() else {
                return Ok(false);
            };

            (source.rgba.clone(), source.width, source.height)
        };

        let mut extra = Vec::with_capacity(8);
        extra.extend_from_slice(&width.to_le_bytes());
        extra.extend_from_slice(&height.to_le_bytes());

        create_shared_buffer(webview, &rgba, &extra, "capture-window-source".to_string()).await?;
        Ok(true)
    }
}

#[command]
pub fn clear_capture_window_source(
    state: State<'_, CaptureWindowSourceState>,
) -> Result<(), String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "Failed to lock capture window source state".to_string())?;
    *guard = None;
    Ok(())
}

#[command]
pub fn take_capture_window_source_crop_png(
    state: State<'_, CaptureWindowSourceState>,
    crop: CaptureWindowSourceCropInput,
) -> Result<Option<CaptureWindowSourceCropPayload>, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = state;
        let _ = crop;
        Ok(None)
    }

    #[cfg(target_os = "windows")]
    {
        let capture = state
            .0
            .lock()
            .map_err(|_| "Failed to lock capture window source state".to_string())?;
        let Some(source) = capture.as_ref() else {
            return Ok(None);
        };

        let (width, height, rgba) = crop_rgba_region(
            source.width,
            source.height,
            &source.rgba,
            crop.left,
            crop.top,
            crop.width,
            crop.height,
        )?;
        let png = encode_png_rgba(width, height, &rgba)?;

        Ok(Some(CaptureWindowSourceCropPayload { width, height, png }))
    }
}
