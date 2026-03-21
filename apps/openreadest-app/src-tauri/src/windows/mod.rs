use image::codecs::png::PngEncoder;
use image::{ColorType, ImageEncoder};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use tauri::Window;
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
    SRCCOPY,
};
use windows::Win32::UI::WindowsAndMessaging::GetClientRect;

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

#[tauri::command]
pub fn capture_current_window_png(window: Window) -> Result<Vec<u8>, String> {
    let hwnd = hwnd_from_window(&window)?;
    let (width, height, mut bgra) = capture_client_bgra(hwnd)?;

    for pixel in bgra.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }

    let mut png = Vec::new();
    PngEncoder::new(&mut png)
        .write_image(&bgra, width, height, ColorType::Rgba8.into())
        .map_err(|error| format!("Failed to encode PNG: {error}"))?;

    Ok(png)
}
