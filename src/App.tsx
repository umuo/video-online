import { FormEvent, lazy, Suspense, useEffect, useState } from "react";
import {
  ArrowRight,
  CirclePlay,
  Clapperboard,
  EyeOff,
  LockKeyhole,
  Radio,
  Sparkles,
  Users,
} from "lucide-react";
import { createRoom, normalizeRoomCode } from "./lib/api";
import type { SourceType } from "./types";

const Room = lazy(() => import("./components/Room"));

function getRoomId(pathname: string) {
  return pathname.match(/^\/room\/([A-Z0-9]{6})\/?$/i)?.[1]?.toUpperCase() ?? null;
}

function navigate(path: string) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function Wordmark({ inverse = false }: { inverse?: boolean }) {
  return (
    <button className={`wordmark ${inverse ? "wordmark-inverse" : ""}`} onClick={() => navigate("/")}>
      <span className="wordmark-mark" aria-hidden="true">
        <span />
        <span />
      </span>
      <span>同映</span>
    </button>
  );
}

function Landing() {
  const [sourceType, setSourceType] = useState<SourceType>("video");
  const [title, setTitle] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [password, setPassword] = useState("");
  const [nickname, setNickname] = useState(() => localStorage.getItem("tongying:nickname") || "");
  const [joinCode, setJoinCode] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState("");

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!nickname.trim()) {
      setError("先给自己起个名字吧");
      return;
    }
    if (!sourceUrl.trim()) {
      setError("请填写视频或直播地址");
      return;
    }

    setIsCreating(true);
    try {
      const response = await createRoom({
        title: title.trim(),
        sourceUrl: sourceUrl.trim(),
        sourceType,
        password: password.trim() || undefined,
      });
      localStorage.setItem("tongying:nickname", nickname.trim());
      localStorage.setItem(`tongying:host:${response.room.id}`, response.hostToken);
      sessionStorage.setItem(`tongying:auto:${response.room.id}`, "1");
      navigate(`/room/${response.room.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "房间创建失败，请再试一次");
    } finally {
      setIsCreating(false);
    }
  }

  function handleJoin(event: FormEvent) {
    event.preventDefault();
    const code = normalizeRoomCode(joinCode);
    if (code.length !== 6) {
      setError("房间号是 6 位字符");
      return;
    }
    navigate(`/room/${code}`);
  }

  return (
    <main className="landing-page">
      <header className="landing-header page-width">
        <Wordmark />
        <form className="quick-join" onSubmit={handleJoin}>
          <label htmlFor="quick-code" className="sr-only">输入房间号</label>
          <input
            id="quick-code"
            inputMode="text"
            autoComplete="off"
            placeholder="输入房间号"
            value={joinCode}
            onChange={(event) => setJoinCode(normalizeRoomCode(event.target.value))}
          />
          <button type="submit" aria-label="加入房间">
            加入 <ArrowRight size={15} />
          </button>
        </form>
      </header>

      <section className="hero page-width">
        <div className="hero-copy">
          <div className="eyebrow"><span /> 今晚，不散场</div>
          <h1>距离不同，<br />也能坐在<span>同一排。</span></h1>
          <p className="hero-lead">
            创建一个线上放映室，把链接发给朋友。电影、直播、弹幕和笑声，全部实时同步。
          </p>
          <div className="feature-strip" aria-label="功能亮点">
            <span><CirclePlay size={17} /> 房主控场</span>
            <span><Users size={17} /> 多人同步</span>
            <span><EyeOff size={17} /> 弹幕不留痕</span>
          </div>
          <div className="film-note" aria-hidden="true">
            <span>PLAY TOGETHER</span>
            <span>NO. 01</span>
          </div>
        </div>

        <div className="create-card-wrap">
          <div className="create-card-glow" />
          <form className="create-card" onSubmit={handleCreate}>
            <div className="card-heading">
              <div>
                <p>NEW SCREENING</p>
                <h2>开一间放映室</h2>
              </div>
              <Sparkles size={22} aria-hidden="true" />
            </div>

            <div className="source-toggle" role="group" aria-label="播放类型">
              <button
                type="button"
                className={sourceType === "video" ? "active" : ""}
                onClick={() => setSourceType("video")}
              >
                <Clapperboard size={16} /> 视频
              </button>
              <button
                type="button"
                className={sourceType === "live" ? "active" : ""}
                onClick={() => setSourceType("live")}
              >
                <Radio size={16} /> 直播
              </button>
            </div>

            <label className="field">
              <span>{sourceType === "live" ? "直播地址" : "播放地址"} <b>必填</b></span>
              <input
                type="url"
                inputMode="url"
                placeholder={sourceType === "live" ? "https://example.com/live.m3u8" : "https://example.com/movie.mp4"}
                value={sourceUrl}
                onChange={(event) => setSourceUrl(event.target.value)}
                required
              />
              <small>支持 MP4、WebM、HLS（.m3u8）等浏览器可播放格式</small>
            </label>

            <div className="field-row">
              <label className="field">
                <span>放映标题</span>
                <input
                  type="text"
                  maxLength={60}
                  placeholder={sourceType === "live" ? "今晚一起看直播" : "今晚的电影"}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <label className="field">
                <span>你的昵称 <b>必填</b></span>
                <input
                  type="text"
                  maxLength={16}
                  placeholder="房主昵称"
                  value={nickname}
                  onChange={(event) => setNickname(event.target.value)}
                  required
                />
              </label>
            </div>

            <label className="field field-password">
              <span>房间密码 <em>选填</em></span>
              <div className="input-with-icon">
                <LockKeyhole size={16} />
                <input
                  type="password"
                  maxLength={64}
                  autoComplete="new-password"
                  placeholder="留空就是公开房间"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>
            </label>

            {error && <p className="form-error" role="alert">{error}</p>}

            <button className="primary-button" type="submit" disabled={isCreating}>
              {isCreating ? "正在布置放映室…" : "创建放映室"}
              {!isCreating && <ArrowRight size={18} />}
            </button>
            <p className="privacy-note">创建即开播 · 无需注册 · 弹幕不会保存在服务端</p>
          </form>
        </div>
      </section>

      <footer className="landing-footer page-width">
        <span>同映 / TONG YING</span>
        <span>把好电影，留给一起看的人。</span>
      </footer>
    </main>
  );
}

export default function App() {
  const [pathname, setPathname] = useState(window.location.pathname);

  useEffect(() => {
    const handleNavigation = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", handleNavigation);
    return () => window.removeEventListener("popstate", handleNavigation);
  }, []);

  const roomId = getRoomId(pathname);
  if (roomId) {
    return (
      <Suspense fallback={<main className="room-loading"><span className="spin">◌</span><p>正在准备放映室…</p></main>}>
        <Room key={roomId} roomId={roomId} onExit={() => navigate("/")} />
      </Suspense>
    );
  }
  return <Landing />;
}

export { Wordmark };
