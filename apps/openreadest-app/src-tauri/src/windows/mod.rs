use image::codecs::png::PngEncoder;
use image::{ColorType, ImageEncoder};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use serde::Deserialize;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use std::time::Instant;
use tauri::Window;
use windows::core::{factory, Interface};
use windows::Foundation::TypedEventHandler;
use windows::Graphics::Capture::{
    Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession,
};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::{HMODULE, HWND, RECT};
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Resource, ID3D11Texture2D,
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE,
    D3D11_MAP_READ, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
    SRCCOPY,
};
use windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::UI::WindowsAndMessaging::GetClientRect;

#[derive(Clone)]
struct CachedCapture {
    backend: String,
    width: u32,
    height: u32,
    rgba: Vec<u8>,
}

#[derive(Serialize)]
pub struct CachedCapturePayload {
    backend: String,
    width: u32,
    height: u32,
    png: Vec<u8>,
}

#[derive(Serialize)]
pub struct CachedCaptureInfoPayload {
    backend: String,
    width: u32,
    height: u32,
}

#[derive(Deserialize)]
pub struct CachedCaptureCropInput {
    left: u32,
    top: u32,
    width: u32,
    height: u32,
}

struct WarmCaptureHandle {
    stop: Arc<AtomicBool>,
    hwnd: isize,
}

fn capture_cache() -> &'static Mutex<Option<CachedCapture>> {
    static CACHE: OnceLock<Mutex<Option<CachedCapture>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn warm_capture_handle() -> &'static Mutex<Option<WarmCaptureHandle>> {
    static HANDLE: OnceLock<Mutex<Option<WarmCaptureHandle>>> = OnceLock::new();
    HANDLE.get_or_init(|| Mutex::new(None))
}

fn hwnd_from_window(window: &Window) -> Result<HWND, String> {
    let handle = window
        .window_handle()
        .map_err(|error| format!("Failed to get native window handle: {error}"))?;

    match handle.as_raw() {
        RawWindowHandle::Win32(handle) => Ok(HWND(handle.hwnd.get() as *mut _)),
        _ => Err("Unsupported window handle type for Windows capture".to_string()),
    }
}

fn capture_client_bgra(hwnd: HWND) -> Result<(u32, u32, Vec<u8>), String> {
    let mut client_rect = RECT::default();
    unsafe {
        GetClientRect(hwnd, &mut client_rect)
            .map_err(|error| format!("Failed to get client rect: {error}"))?;
    }

    let width = (client_rect.right - client_rect.left).max(0) as i32;
    let height = (client_rect.bottom - client_rect.top).max(0) as i32;
    if width == 0 || height == 0 {
        return Err("Current window client area is empty".to_string());
    }

    let window_dc = unsafe { GetDC(Some(hwnd)) };
    if window_dc.0.is_null() {
        return Err("Failed to acquire window device context".to_string());
    }

    let memory_dc = unsafe { CreateCompatibleDC(Some(window_dc)) };
    if memory_dc.0.is_null() {
        unsafe {
            let _ = ReleaseDC(Some(hwnd), window_dc);
        }
        return Err("Failed to create compatible device context".to_string());
    }

    let bitmap = unsafe { CreateCompatibleBitmap(window_dc, width, height) };
    if bitmap.0.is_null() {
        unsafe {
            let _ = DeleteDC(memory_dc);
            let _ = ReleaseDC(Some(hwnd), window_dc);
        }
        return Err("Failed to create compatible bitmap".to_string());
    }

    let previous = unsafe { SelectObject(memory_dc, HGDIOBJ(bitmap.0)) };
    unsafe {
        BitBlt(
            memory_dc,
            0,
            0,
            width,
            height,
            Some(window_dc),
            0,
            0,
            SRCCOPY,
        )
        .map_err(|error| format!("Failed to capture window client area: {error}"))?;
    }

    let mut bitmap_info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut pixels = vec![0u8; (width as usize) * (height as usize) * 4];

    let scanlines = unsafe {
        GetDIBits(
            memory_dc,
            bitmap,
            0,
            height as u32,
            Some(pixels.as_mut_ptr() as *mut _),
            &mut bitmap_info,
            DIB_RGB_COLORS,
        )
    };

    unsafe {
        let _ = SelectObject(memory_dc, previous);
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = DeleteDC(memory_dc);
        let _ = ReleaseDC(Some(hwnd), window_dc);
    }

    if scanlines == 0 {
        return Err("Failed to extract bitmap pixels".to_string());
    }

    Ok((width as u32, height as u32, pixels))
}

fn create_d3d_device() -> Result<(ID3D11Device, ID3D11DeviceContext), String> {
    let mut device = None;
    let mut context = None;
    let feature_levels = [D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0];

    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&feature_levels),
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )
        .map_err(|error| format!("Failed to create D3D11 device: {error}"))?;
    }

    let device = device.ok_or_else(|| "D3D11 device was not returned".to_string())?;
    let context = context.ok_or_else(|| "D3D11 device context was not returned".to_string())?;

    Ok((device, context))
}

fn create_capture_item_for_window(hwnd: HWND) -> Result<GraphicsCaptureItem, String> {
    let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
        .map_err(|error| format!("Failed to get GraphicsCaptureItem interop factory: {error}"))?;

    unsafe { interop.CreateForWindow(hwnd) }
        .map_err(|error| format!("Failed to create GraphicsCaptureItem for window: {error}"))
}

fn capture_wgc_bgra(hwnd: HWND) -> Result<(u32, u32, Vec<u8>), String> {
    let is_supported = GraphicsCaptureSession::IsSupported()
        .map_err(|error| format!("Failed to query WGC support: {error}"))?;
    if !is_supported {
        return Err("Windows.Graphics.Capture is not supported on this system".to_string());
    }

    let item = create_capture_item_for_window(hwnd)?;
    let size = item
        .Size()
        .map_err(|error| format!("Failed to get capture item size: {error}"))?;
    if size.Width <= 0 || size.Height <= 0 {
        return Err("Current window client area is empty".to_string());
    }

    let (device, context) = create_d3d_device()?;
    let dxgi_device: IDXGIDevice = device
        .cast()
        .map_err(|error| format!("Failed to cast D3D11 device to DXGI device: {error}"))?;
    let direct3d_device = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi_device) }
        .map_err(|error| format!("Failed to create WinRT Direct3D device: {error}"))?;
    let direct3d_device: IDirect3DDevice = direct3d_device
        .cast()
        .map_err(|error| format!("Failed to cast WinRT Direct3D device: {error}"))?;

    let frame_pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
        &direct3d_device,
        DirectXPixelFormat::B8G8R8A8UIntNormalized,
        1,
        size,
    )
    .map_err(|error| format!("Failed to create WGC frame pool: {error}"))?;

    let session = frame_pool
        .CreateCaptureSession(&item)
        .map_err(|error| format!("Failed to create WGC capture session: {error}"))?;
    let _ = session.SetIsBorderRequired(false);
    let _ = session.SetIsCursorCaptureEnabled(false);

    let (sender, receiver) = mpsc::sync_channel::<Result<Direct3D11CaptureFrame, String>>(1);
    let frame_pool_for_handler = frame_pool.clone();
    let token = frame_pool
        .FrameArrived(&TypedEventHandler::new(move |_, _| {
            let result = frame_pool_for_handler
                .TryGetNextFrame()
                .map_err(|error| format!("Failed to acquire WGC frame: {error}"));
            let _ = sender.send(result);
            Ok(())
        }))
        .map_err(|error| format!("Failed to subscribe to WGC frame arrival: {error}"))?;

    let cleanup = || -> Result<(), String> {
        frame_pool
            .RemoveFrameArrived(token)
            .map_err(|error| format!("Failed to unsubscribe WGC frame handler: {error}"))?;
        session
            .Close()
            .map_err(|error| format!("Failed to close WGC capture session: {error}"))?;
        frame_pool
            .Close()
            .map_err(|error| format!("Failed to close WGC frame pool: {error}"))?;
        Ok(())
    };

    session
        .StartCapture()
        .map_err(|error| format!("Failed to start WGC capture session: {error}"))?;

    let frame = match receiver.recv_timeout(Duration::from_millis(1500)) {
        Ok(result) => result?,
        Err(_) => {
            let _ = cleanup();
            return Err("Timed out waiting for WGC frame".to_string());
        }
    };

    let result = extract_frame_bgra(&context, &frame);
    frame.Close().ok();
    cleanup()?;
    result
}

fn extract_frame_bgra(
    context: &ID3D11DeviceContext,
    frame: &Direct3D11CaptureFrame,
) -> Result<(u32, u32, Vec<u8>), String> {
    let content_size = frame
        .ContentSize()
        .map_err(|error| format!("Failed to get WGC frame size: {error}"))?;
    let width = content_size.Width.max(0) as u32;
    let height = content_size.Height.max(0) as u32;
    if width == 0 || height == 0 {
        return Err("Captured WGC frame is empty".to_string());
    }

    let surface = frame
        .Surface()
        .map_err(|error| format!("Failed to get WGC frame surface: {error}"))?;
    let dxgi_access: IDirect3DDxgiInterfaceAccess = surface
        .cast()
        .map_err(|error| format!("Failed to access DXGI surface from WGC frame: {error}"))?;
    let texture: ID3D11Texture2D = unsafe { dxgi_access.GetInterface() }
        .map_err(|error| format!("Failed to get D3D11 texture from WGC frame: {error}"))?;

    let mut source_desc = D3D11_TEXTURE2D_DESC::default();
    unsafe {
        texture.GetDesc(&mut source_desc);
    }

    let mut staging_desc = source_desc;
    staging_desc.Width = width;
    staging_desc.Height = height;
    staging_desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    staging_desc.BindFlags = 0;
    staging_desc.MiscFlags = 0;
    staging_desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
    staging_desc.Usage = D3D11_USAGE_STAGING;
    staging_desc.SampleDesc = DXGI_SAMPLE_DESC {
        Count: 1,
        Quality: 0,
    };
    staging_desc.ArraySize = 1;
    staging_desc.MipLevels = 1;

    let source_resource: ID3D11Resource = texture
        .cast()
        .map_err(|error| format!("Failed to cast WGC texture to resource: {error}"))?;

    let staging_texture = unsafe {
        let mut staging_texture = None;
        texture
            .GetDevice()
            .map_err(|error| format!("Failed to get D3D11 device from texture: {error}"))?
            .CreateTexture2D(&staging_desc, None, Some(&mut staging_texture))
            .map_err(|error| format!("Failed to create staging texture for WGC frame: {error}"))?;
        staging_texture.ok_or_else(|| "Staging texture was not returned".to_string())?
    };

    let staging_resource: ID3D11Resource = staging_texture
        .cast()
        .map_err(|error| format!("Failed to cast staging texture to resource: {error}"))?;

    unsafe {
        context.CopyResource(&staging_resource, &source_resource);
    }

    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    unsafe {
        context
            .Map(&staging_resource, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
            .map_err(|error| format!("Failed to map staging texture: {error}"))?;
    }

    let mut pixels = vec![0u8; (width as usize) * (height as usize) * 4];
    let row_bytes = width as usize * 4;
    let source_pitch = mapped.RowPitch as usize;

    unsafe {
        let source = mapped.pData as *const u8;
        for row in 0..height as usize {
            let source_row = source.add(row * source_pitch);
            let target_row = row * row_bytes;
            std::ptr::copy_nonoverlapping(
                source_row,
                pixels[target_row..target_row + row_bytes].as_mut_ptr(),
                row_bytes,
            );
        }
        context.Unmap(&staging_resource, 0);
    }

    Ok((width, height, pixels))
}

fn is_low_information_bgra(width: u32, height: u32, pixels: &[u8]) -> bool {
    let sample_width = width.min(64) as usize;
    let sample_height = height.min(64) as usize;
    if sample_width < 2 || sample_height < 2 {
        return true;
    }

    let stride = width as usize * 4;
    let mut non_white = 0usize;
    let mut non_transparent = 0usize;
    for row in 0..sample_height {
        for col in 0..sample_width {
            let idx = row * stride + col * 4;
            let b = pixels.get(idx).copied().unwrap_or(255);
            let g = pixels.get(idx + 1).copied().unwrap_or(255);
            let r = pixels.get(idx + 2).copied().unwrap_or(255);
            let a = pixels.get(idx + 3).copied().unwrap_or(0);
            if a > 0 {
                non_transparent += 1;
            }
            if !(r > 245 && g > 245 && b > 245) {
                non_white += 1;
            }
        }
    }

    let total = sample_width * sample_height;
    non_transparent < (total * 3) / 100 || non_white < (total * 3) / 100
}

fn encode_png_rgba(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let mut png = Vec::new();
    PngEncoder::new(&mut png)
        .write_image(rgba, width, height, ColorType::Rgba8.into())
        .map_err(|error| format!("Failed to encode PNG: {error}"))?;
    Ok(png)
}

fn crop_rgba_region(
    width: u32,
    height: u32,
    rgba: &[u8],
    left: u32,
    top: u32,
    crop_width: u32,
    crop_height: u32,
) -> Result<(u32, u32, Vec<u8>), String> {
    if width == 0 || height == 0 {
        return Err("Cached capture is empty".to_string());
    }

    let clamped_left = left.min(width.saturating_sub(1));
    let clamped_top = top.min(height.saturating_sub(1));
    let clamped_width = crop_width.max(1).min(width.saturating_sub(clamped_left));
    let clamped_height = crop_height.max(1).min(height.saturating_sub(clamped_top));
    let src_stride = width as usize * 4;
    let dst_stride = clamped_width as usize * 4;
    let mut cropped = vec![0u8; dst_stride * clamped_height as usize];

    for row in 0..clamped_height as usize {
        let src_row = (clamped_top as usize + row) * src_stride + clamped_left as usize * 4;
        let dst_row = row * dst_stride;
        cropped[dst_row..dst_row + dst_stride]
            .copy_from_slice(&rgba[src_row..src_row + dst_stride]);
    }

    Ok((clamped_width, clamped_height, cropped))
}

fn capture_current_window_png_internal(hwnd: HWND) -> Result<CachedCapture, String> {
    let start = Instant::now();
    let wgc_attempt = capture_wgc_bgra(hwnd);
    let (capture_backend, width, height, mut bgra) = match wgc_attempt {
        Ok((width, height, pixels)) => {
            log::info!(
                "capture_current_window_png backend=WGC size={}x{} elapsed_ms={}",
                width,
                height,
                start.elapsed().as_millis()
            );
            if is_low_information_bgra(width, height, &pixels) {
                log::warn!(
                    "WGC capture looked low-information, falling back to GDI before PNG encode"
                );
                let (width, height, pixels) = capture_client_bgra(hwnd)?;
                log::info!(
                    "capture_current_window_png backend=GDI size={}x{} elapsed_ms={}",
                    width,
                    height,
                    start.elapsed().as_millis()
                );
                if is_low_information_bgra(width, height, &pixels) {
                    log::warn!("GDI capture also looked low-information; returning it for frontend-side crop validation");
                }
                ("gdi", width, height, pixels)
            } else {
                ("wgc", width, height, pixels)
            }
        }
        Err(wgc_error) => {
            log::warn!("WGC capture failed, falling back to GDI: {wgc_error}");
            let (width, height, pixels) = capture_client_bgra(hwnd)?;
            log::info!(
                "capture_current_window_png backend=GDI size={}x{} elapsed_ms={}",
                width,
                height,
                start.elapsed().as_millis()
            );
            if is_low_information_bgra(width, height, &pixels) {
                log::warn!("GDI capture looked low-information; returning it for frontend-side crop validation");
            }
            ("gdi", width, height, pixels)
        }
    };

    for pixel in bgra.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }

    Ok(CachedCapture {
        backend: capture_backend.to_string(),
        width,
        height,
        rgba: bgra,
    })
}

#[tauri::command]
pub fn warm_current_window_capture(window: Window) -> Result<(), String> {
    let hwnd = hwnd_from_window(&window)?;

    {
        let mut handle = warm_capture_handle()
            .lock()
            .map_err(|_| "Failed to lock capture warmup state".to_string())?;
        if let Some(existing) = handle.as_ref() {
            if existing.hwnd == hwnd.0 as isize && !existing.stop.load(Ordering::Relaxed) {
                return Ok(());
            }
            existing.stop.store(true, Ordering::Relaxed);
        }

        let stop = Arc::new(AtomicBool::new(false));
        *handle = Some(WarmCaptureHandle {
            stop: stop.clone(),
            hwnd: hwnd.0 as isize,
        });

        if let Ok(mut cache) = capture_cache().lock() {
            *cache = None;
        }

        let hwnd_raw = hwnd.0 as isize;
        thread::spawn(move || {
            let hwnd = HWND(hwnd_raw as *mut _);
            let item = match create_capture_item_for_window(hwnd) {
                Ok(item) => item,
                Err(error) => {
                    log::warn!(
                        "warm_current_window_capture failed to create capture item: {error}"
                    );
                    return;
                }
            };

            let size = match item.Size() {
                Ok(size) if size.Width > 0 && size.Height > 0 => size,
                Ok(_) => {
                    log::warn!("warm_current_window_capture received empty item size");
                    return;
                }
                Err(error) => {
                    log::warn!("warm_current_window_capture failed to get item size: {error}");
                    return;
                }
            };

            let (device, context) = match create_d3d_device() {
                Ok(pair) => pair,
                Err(error) => {
                    log::warn!("warm_current_window_capture failed to create D3D device: {error}");
                    return;
                }
            };

            let dxgi_device: IDXGIDevice = match device.cast() {
                Ok(device) => device,
                Err(error) => {
                    log::warn!("warm_current_window_capture failed to cast DXGI device: {error}");
                    return;
                }
            };

            let direct3d_device = match unsafe {
                CreateDirect3D11DeviceFromDXGIDevice(&dxgi_device)
            } {
                Ok(device) => match device.cast::<IDirect3DDevice>() {
                    Ok(device) => device,
                    Err(error) => {
                        log::warn!(
                            "warm_current_window_capture failed to cast WinRT device: {error}"
                        );
                        return;
                    }
                },
                Err(error) => {
                    log::warn!("warm_current_window_capture failed to create WinRT Direct3D device: {error}");
                    return;
                }
            };

            let frame_pool = match Direct3D11CaptureFramePool::CreateFreeThreaded(
                &direct3d_device,
                DirectXPixelFormat::B8G8R8A8UIntNormalized,
                1,
                size,
            ) {
                Ok(pool) => pool,
                Err(error) => {
                    log::warn!("warm_current_window_capture failed to create frame pool: {error}");
                    return;
                }
            };

            let session = match frame_pool.CreateCaptureSession(&item) {
                Ok(session) => session,
                Err(error) => {
                    log::warn!(
                        "warm_current_window_capture failed to create capture session: {error}"
                    );
                    let _ = frame_pool.Close();
                    return;
                }
            };
            let _ = session.SetIsBorderRequired(false);
            let _ = session.SetIsCursorCaptureEnabled(false);

            let frame_pool_for_handler = frame_pool.clone();
            let context_for_handler = context.clone();
            let stop_for_handler = stop.clone();
            let token = match frame_pool.FrameArrived(&TypedEventHandler::new(move |_, _| {
                if stop_for_handler.load(Ordering::Relaxed) {
                    return Ok(());
                }
                if let Ok(frame) = frame_pool_for_handler.TryGetNextFrame() {
                    if let Ok((width, height, mut bgra)) =
                        extract_frame_bgra(&context_for_handler, &frame)
                    {
                        for pixel in bgra.chunks_exact_mut(4) {
                            pixel.swap(0, 2);
                        }
                        if let Ok(mut cache) = capture_cache().lock() {
                            *cache = Some(CachedCapture {
                                backend: "wgc-warm".to_string(),
                                width,
                                height,
                                rgba: bgra,
                            });
                        }
                    }
                    let _ = frame.Close();
                }
                Ok(())
            })) {
                Ok(token) => token,
                Err(error) => {
                    log::warn!(
                        "warm_current_window_capture failed to subscribe frame handler: {error}"
                    );
                    let _ = session.Close();
                    let _ = frame_pool.Close();
                    return;
                }
            };

            if let Err(error) = session.StartCapture() {
                log::warn!("warm_current_window_capture failed to start capture: {error}");
                let _ = frame_pool.RemoveFrameArrived(token);
                let _ = session.Close();
                let _ = frame_pool.Close();
                return;
            }

            while !stop.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_millis(16));
            }

            let _ = frame_pool.RemoveFrameArrived(token);
            let _ = session.Close();
            let _ = frame_pool.Close();
        });

        return Ok(());
    }
}

#[tauri::command]
pub fn take_cached_current_window_capture_png() -> Result<Option<CachedCapturePayload>, String> {
    let cache = capture_cache()
        .lock()
        .map_err(|_| "Failed to lock cached capture state".to_string())?;
    Ok(cache.as_ref().map(|capture| CachedCapturePayload {
        backend: capture.backend.clone(),
        width: capture.width,
        height: capture.height,
        png: Vec::new(),
    }))
}

#[tauri::command]
pub fn take_cached_current_window_capture_info() -> Result<Option<CachedCaptureInfoPayload>, String>
{
    let cache = capture_cache()
        .lock()
        .map_err(|_| "Failed to lock cached capture state".to_string())?;
    Ok(cache.as_ref().map(|capture| CachedCaptureInfoPayload {
        backend: capture.backend.clone(),
        width: capture.width,
        height: capture.height,
    }))
}

#[tauri::command]
pub fn take_cached_current_window_capture_crop_png(
    crop: CachedCaptureCropInput,
) -> Result<Option<CachedCapturePayload>, String> {
    let cache = capture_cache()
        .lock()
        .map_err(|_| "Failed to lock cached capture state".to_string())?;
    if let Some(capture) = cache.as_ref() {
        let (width, height, rgba) = crop_rgba_region(
            capture.width,
            capture.height,
            &capture.rgba,
            crop.left,
            crop.top,
            crop.width,
            crop.height,
        )?;
        let png = encode_png_rgba(width, height, &rgba)?;
        return Ok(Some(CachedCapturePayload {
            backend: capture.backend.clone(),
            width,
            height,
            png,
        }));
    }
    Ok(None)
}

#[tauri::command]
pub fn clear_cached_current_window_capture() -> Result<(), String> {
    if let Ok(mut cache) = capture_cache().lock() {
        *cache = None;
    }
    if let Ok(mut handle) = warm_capture_handle().lock() {
        if let Some(existing) = handle.take() {
            existing.stop.store(true, Ordering::Relaxed);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn capture_current_window_png(window: Window) -> Result<Vec<u8>, String> {
    let hwnd = hwnd_from_window(&window)?;
    let capture = capture_current_window_png_internal(hwnd)?;

    encode_png_rgba(capture.width, capture.height, &capture.rgba)
}
