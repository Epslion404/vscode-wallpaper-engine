use std::env;
use std::error::Error;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::encoder::{
    AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder,
    VideoSettingsSubType,
};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};
use windows_capture::window::Window;

type CaptureError = Box<dyn Error + Send + Sync>;

#[derive(Clone)]
struct CaptureFlags {
    output_path: PathBuf,
    duration: Duration,
    width: u32,
    height: u32,
}

struct Capture {
    encoder: Option<VideoEncoder>,
    started_at: Instant,
    duration: Duration,
}

impl Capture {
    fn finish(&mut self) -> Result<(), CaptureError> {
        if let Some(encoder) = self.encoder.take() {
            encoder.finish()?;
        }
        Ok(())
    }
}

impl GraphicsCaptureApiHandler for Capture {
    type Flags = CaptureFlags;
    type Error = CaptureError;

    fn new(context: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let encoder = VideoEncoder::new(
            VideoSettingsBuilder::new(context.flags.width, context.flags.height)
                .sub_type(VideoSettingsSubType::H264)
                .frame_rate(30)
                .bitrate(10_000_000),
            AudioSettingsBuilder::default().disabled(true),
            ContainerSettingsBuilder::default(),
            &context.flags.output_path,
        )?;
        eprintln!(
            "capture-start width={} height={} duration_ms={}",
            context.flags.width,
            context.flags.height,
            context.flags.duration.as_millis()
        );
        Ok(Self {
            encoder: Some(encoder),
            started_at: Instant::now(),
            duration: context.flags.duration,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if let Some(encoder) = self.encoder.as_mut() {
            encoder.send_frame(frame)?;
        }
        if self.started_at.elapsed() >= self.duration {
            self.finish()?;
            capture_control.stop();
        }
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        self.finish()
    }
}

fn parse_args() -> Result<(String, Duration, PathBuf), CaptureError> {
    let mut args = env::args_os().skip(1);
    let window_title = args
        .next()
        .and_then(|value| value.into_string().ok())
        .ok_or("missing window title")?;
    let duration_ms = args
        .next()
        .and_then(|value| value.into_string().ok())
        .ok_or("missing duration in milliseconds")?
        .parse::<u64>()?;
    let output_path = args.next().map(PathBuf::from).ok_or("missing output path")?;
    if args.next().is_some() {
        return Err("unexpected extra arguments".into());
    }
    if window_title.is_empty() || duration_ms == 0 {
        return Err("window title and duration must be non-empty".into());
    }
    Ok((window_title, Duration::from_millis(duration_ms), output_path))
}

fn run() -> Result<(), CaptureError> {
    let (window_title, duration, output_path) = parse_args()?;
    let window = Window::from_name(&window_title)?;
    if !window.is_valid() {
        return Err("target window is not capturable".into());
    }
    let width = u32::try_from(window.width()?)?;
    let height = u32::try_from(window.height()?)?;
    let settings = Settings::new(
        window,
        CursorCaptureSettings::WithoutCursor,
        DrawBorderSettings::WithoutBorder,
        SecondaryWindowSettings::Exclude,
        MinimumUpdateIntervalSettings::Custom(Duration::from_millis(33)),
        DirtyRegionSettings::Default,
        ColorFormat::Rgba8,
        CaptureFlags {
            output_path,
            duration,
            width,
            height,
        },
    );
    Capture::start(settings)?;
    eprintln!("capture-complete");
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("capture-error: {error}");
        std::process::exit(1);
    }
}
