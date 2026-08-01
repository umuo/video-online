let castPromise: Promise<boolean> | null = null;

export function prepareGoogleCast(): Promise<boolean> {
  if (castPromise) return castPromise;

  castPromise = new Promise((resolve) => {
    if (window.cast?.framework && window.chrome?.cast) {
      configureCast();
      resolve(true);
      return;
    }

    const timeout = window.setTimeout(() => resolve(false), 8000);
    window.__onGCastApiAvailable = (isAvailable) => {
      window.clearTimeout(timeout);
      if (isAvailable) configureCast();
      resolve(isAvailable);
    };

    if (!document.querySelector('script[data-tongying-cast="true"]')) {
      const script = document.createElement("script");
      script.src = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";
      script.async = true;
      script.dataset.tongyingCast = "true";
      script.onerror = () => {
        window.clearTimeout(timeout);
        resolve(false);
      };
      document.head.appendChild(script);
    }
  });

  return castPromise;
}

function configureCast() {
  const cast = window.cast;
  const chromeCast = window.chrome?.cast;
  if (!cast || !chromeCast) return;

  cast.framework.CastContext.getInstance().setOptions({
    receiverApplicationId: chromeCast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
    autoJoinPolicy: chromeCast.AutoJoinPolicy.ORIGIN_SCOPED,
  });
}

function contentTypeFor(url: string) {
  const cleanUrl = url.split(/[?#]/)[0].toLowerCase();
  if (cleanUrl.endsWith(".m3u8")) return "application/x-mpegURL";
  if (cleanUrl.endsWith(".webm")) return "video/webm";
  if (cleanUrl.endsWith(".ogg") || cleanUrl.endsWith(".ogv")) return "video/ogg";
  return "video/mp4";
}

export async function castWithGoogle(
  video: HTMLVideoElement,
  title: string,
  sourceUrl: string,
  isLive: boolean,
) {
  const available = await prepareGoogleCast();
  const cast = window.cast;
  const chromeCast = window.chrome?.cast;
  if (!available || !cast || !chromeCast) {
    throw new Error("当前浏览器未发现可用的 Chromecast 设备");
  }

  const context = cast.framework.CastContext.getInstance();
  await context.requestSession();
  const session = context.getCurrentSession();
  if (!session) throw new Error("没有连接到投屏设备");

  const mediaInfo = new chromeCast.media.MediaInfo(sourceUrl, contentTypeFor(sourceUrl));
  const metadata = new chromeCast.media.GenericMediaMetadata();
  metadata.title = title;
  metadata.subtitle = "来自同映放映室";
  mediaInfo.metadata = metadata;
  mediaInfo.streamType = isLive
    ? chromeCast.media.StreamType.LIVE
    : chromeCast.media.StreamType.BUFFERED;

  const loadRequest = new chromeCast.media.LoadRequest(mediaInfo);
  loadRequest.autoplay = !video.paused;
  loadRequest.currentTime = isLive ? 0 : video.currentTime;
  await session.loadMedia(loadRequest);
}

export async function castWithNativePicker(video: HTMLVideoElement) {
  if (video.remote?.prompt) {
    await video.remote.prompt();
    return;
  }
  if (video.webkitShowPlaybackTargetPicker) {
    video.webkitShowPlaybackTargetPicker();
    return;
  }
  throw new Error("当前浏览器不支持系统无线播放，请尝试 Chrome 或 Safari");
}
