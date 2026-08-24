import { FormEvent, lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  CirclePlay,
  Clapperboard,
  EyeOff,
  File,
  FileVideo,
  Folder,
  FolderOpen,
  HardDrive,
  LoaderCircle,
  LockKeyhole,
  Plus,
  Radio,
  Save,
  Sparkles,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { browseWebDav, createRoom, normalizeRoomCode } from "./lib/api";
import { resolveNickname } from "./lib/nickname";
import { loadWebDavProfiles, saveWebDavProfiles } from "./lib/webdavProfiles";
import type { WebDavProfile } from "./lib/webdavProfiles";
import type {
  CreateRoomResponse,
  SourceType,
  WebDavBrowseResponse,
  WebDavItem,
} from "./types";

const Room = lazy(() => import("./components/Room"));

function getRoomId(pathname: string) {
  return pathname.match(/^\/room\/([A-Z0-9]{6})\/?$/i)?.[1]?.toUpperCase() ?? null;
}

function navigate(path: string) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function enterCreatedRoom(response: CreateRoomResponse, nickname: string) {
  const cleanNickname = resolveNickname(nickname);
  localStorage.setItem("tongying:nickname", cleanNickname);
  localStorage.setItem(`tongying:host:${response.room.id}`, response.hostToken);
  sessionStorage.setItem(`tongying:auto:${response.room.id}`, "1");
  navigate(`/room/${response.room.id}`);
}

function formatFileSize(bytes: number | null) {
  if (bytes === null) return "大小未知";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

function WebDavBrowser({
  nickname,
  roomTitle,
  roomPassword,
  onClose,
}: {
  nickname: string;
  roomTitle: string;
  roomPassword: string;
  onClose: () => void;
}) {
  const [baseUrl, setBaseUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [profiles, setProfiles] = useState<WebDavProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [profileName, setProfileName] = useState("");
  const [profileNotice, setProfileNotice] = useState("");
  const [listing, setListing] = useState<WebDavBrowseResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [creatingPath, setCreatingPath] = useState("");
  const [error, setError] = useState("");
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    loadWebDavProfiles()
      .then((savedProfiles) => {
        if (!active) return;
        setProfiles(savedProfiles);
        const first = savedProfiles[0];
        if (first) {
          setSelectedProfileId(first.id);
          setProfileName(first.name);
          setBaseUrl(first.baseUrl);
          setUsername(first.username);
          setPassword(first.password);
        }
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : "WebDAV 配置读取失败");
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !creatingPath) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      requestRef.current?.abort();
    };
  }, [creatingPath, onClose]);

  function suggestedProfileName() {
    if (profileName.trim()) return profileName.trim().slice(0, 32);
    try {
      return new URL(baseUrl.trim()).hostname.slice(0, 32) || "我的 WebDAV";
    } catch {
      return "我的 WebDAV";
    }
  }

  async function persistCurrentProfile(showNotice = true) {
    const cleanBaseUrl = baseUrl.trim();
    if (!cleanBaseUrl) throw new Error("请先填写 WebDAV 服务地址");
    const id = selectedProfileId || crypto.randomUUID();
    const profile: WebDavProfile = {
      id,
      name: suggestedProfileName(),
      baseUrl: cleanBaseUrl,
      username: username.trim(),
      password,
    };
    const nextProfiles = profiles.some((item) => item.id === id)
      ? profiles.map((item) => item.id === id ? profile : item)
      : [...profiles, profile];
    await saveWebDavProfiles(nextProfiles);
    setProfiles(nextProfiles);
    setSelectedProfileId(id);
    setProfileName(profile.name);
    if (showNotice) setProfileNotice("配置已加密保存到本机");
  }

  function selectProfile(id: string) {
    setSelectedProfileId(id);
    setListing(null);
    setError("");
    setProfileNotice("");
    const profile = profiles.find((item) => item.id === id);
    if (profile) {
      setProfileName(profile.name);
      setBaseUrl(profile.baseUrl);
      setUsername(profile.username);
      setPassword(profile.password);
      return;
    }
    setProfileName("");
    setBaseUrl("");
    setUsername("");
    setPassword("");
  }

  async function deleteSelectedProfile() {
    if (!selectedProfileId) return;
    const current = profiles.find((item) => item.id === selectedProfileId);
    if (!window.confirm(`确定删除 WebDAV 配置「${current?.name || "未命名"}」吗？`)) return;
    const nextProfiles = profiles.filter((item) => item.id !== selectedProfileId);
    try {
      await saveWebDavProfiles(nextProfiles);
      setProfiles(nextProfiles);
      setProfileNotice("配置已从本机删除");
      const next = nextProfiles[0];
      if (next) {
        setSelectedProfileId(next.id);
        setProfileName(next.name);
        setBaseUrl(next.baseUrl);
        setUsername(next.username);
        setPassword(next.password);
      } else {
        setSelectedProfileId("");
        setProfileName("");
        setBaseUrl("");
        setUsername("");
        setPassword("");
        setListing(null);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "删除 WebDAV 配置失败");
    }
  }

  async function load(path = "/", page = 1) {
    const url = baseUrl.trim();
    if (!url) {
      setError("请填写 WebDAV 服务地址");
      return;
    }
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setIsLoading(true);
    setError("");
    try {
      const response = await browseWebDav({
        baseUrl: url,
        username: username.trim(),
        password,
        path,
        page,
        pageSize: 10,
      }, controller.signal);
      setListing(response);
      if (path === "/" && page === 1) {
        try {
          await persistCurrentProfile(false);
          setProfileNotice("连接成功，配置已加密保存");
        } catch {
          setProfileNotice("连接成功，但配置未能保存到本机");
        }
      }
    } catch (caught) {
      if (!controller.signal.aborted) {
        setError(caught instanceof Error ? caught.message : "WebDAV 目录读取失败");
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setIsLoading(false);
      }
    }
  }

  async function createFromFile(item: WebDavItem) {
    setCreatingPath(item.path);
    setError("");
    try {
      const response = await createRoom({
        title: roomTitle.trim() || item.name.replace(/\.[^.]+$/, ""),
        sourceType: "video",
        password: roomPassword.trim() || undefined,
        webdav: {
          baseUrl: baseUrl.trim(),
          username: username.trim(),
          password,
          path: item.path,
          contentType: item.contentType,
        },
      });
      enterCreatedRoom(response, nickname);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "房间创建失败，请再试一次");
      setCreatingPath("");
    }
  }

  function submitConnection(event: FormEvent) {
    event.preventDefault();
    void load("/", 1);
  }

  return (
    <div
      className="webdav-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !creatingPath) onClose();
      }}
    >
      <section className="webdav-dialog" role="dialog" aria-modal="true" aria-labelledby="webdav-title">
        <header className="webdav-dialog-header">
          <div className="webdav-title-mark"><HardDrive size={20} /></div>
          <div>
            <p>MEDIA LIBRARY</p>
            <h2 id="webdav-title">从 WebDAV 选择视频</h2>
          </div>
          <button type="button" onClick={onClose} disabled={Boolean(creatingPath)} aria-label="关闭 WebDAV 资源库">
            <X size={19} />
          </button>
        </header>

        <div className="webdav-profile-bar">
          <label>
            <span>已保存配置</span>
            <select
              value={selectedProfileId}
              onChange={(event) => selectProfile(event.target.value)}
              disabled={isLoading || Boolean(creatingPath)}
            >
              <option value="">＋ 新建配置</option>
              {profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}
            </select>
          </label>
          <label>
            <span>配置名称</span>
            <input
              type="text"
              maxLength={32}
              placeholder="例如：家庭影视库"
              value={profileName}
              onChange={(event) => setProfileName(event.target.value)}
              disabled={isLoading || Boolean(creatingPath)}
            />
          </label>
          <div className="webdav-profile-actions">
            <button
              type="button"
              onClick={() => void persistCurrentProfile().catch((caught) => setError(caught instanceof Error ? caught.message : "保存配置失败"))}
              disabled={isLoading || Boolean(creatingPath) || !baseUrl.trim()}
            >
              <Save size={14} /> 保存
            </button>
            <button
              className="danger"
              type="button"
              onClick={() => void deleteSelectedProfile()}
              disabled={isLoading || Boolean(creatingPath) || !selectedProfileId}
              aria-label="删除当前 WebDAV 配置"
            >
              <Trash2 size={14} />
            </button>
            <button
              type="button"
              onClick={() => selectProfile("")}
              disabled={isLoading || Boolean(creatingPath)}
              aria-label="新建 WebDAV 配置"
            >
              <Plus size={14} />
            </button>
          </div>
        </div>

        <form className="webdav-connection" onSubmit={submitConnection}>
          <label className="field webdav-url-field">
            <span>WebDAV 地址 <b>必填</b></span>
            <input
              autoFocus
              type="url"
              inputMode="url"
              placeholder="https://dav.example.com/remote.php/dav/files/you/"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              disabled={isLoading || Boolean(creatingPath)}
              required
            />
          </label>
          <label className="field">
            <span>账号</span>
            <input
              type="text"
              autoComplete="username"
              placeholder="WebDAV 账号"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              disabled={isLoading || Boolean(creatingPath)}
            />
          </label>
          <label className="field">
            <span>密码 / 应用密码</span>
            <input
              type="password"
              autoComplete="current-password"
              placeholder="WebDAV 密码"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={isLoading || Boolean(creatingPath)}
            />
          </label>
          <button className="webdav-connect-button" type="submit" disabled={isLoading || Boolean(creatingPath)}>
            {isLoading ? <LoaderCircle className="spin-icon" size={16} /> : <FolderOpen size={16} />}
            {listing ? "重新连接" : "连接并浏览"}
          </button>
        </form>

        <div className="webdav-security-note">
          配置在本机加密保存；账号密码使用 AES-GCM + RSA-OAEP 封装后再发送，不会以明文出现在请求体中。
        </div>

        {profileNotice && <p className="webdav-profile-notice">{profileNotice}</p>}

        {listing && (
          <div className="webdav-library">
            <div className="webdav-pathbar">
              <button
                type="button"
                onClick={() => listing.parentPath && void load(listing.parentPath, 1)}
                disabled={!listing.parentPath || isLoading || Boolean(creatingPath)}
                aria-label="返回上一级目录"
              >
                <ChevronLeft size={17} />
              </button>
              <Folder size={15} />
              <span title={listing.path}>{listing.path}</span>
              <em>{listing.total} 项</em>
            </div>

            <div className={`webdav-resource-list ${isLoading ? "is-loading" : ""}`} aria-busy={isLoading}>
              {listing.items.length === 0 && (
                <div className="webdav-empty"><FolderOpen size={28} /><span>这个目录是空的</span></div>
              )}
              {listing.items.map((item) => (
                <div className="webdav-resource" key={item.path}>
                  <div className={`webdav-resource-icon ${item.isVideo ? "video" : ""}`}>
                    {item.isDirectory
                      ? <Folder size={20} fill="currentColor" />
                      : item.isVideo ? <FileVideo size={20} /> : <File size={20} />}
                  </div>
                  <button
                    className="webdav-resource-name"
                    type="button"
                    onClick={() => item.isDirectory && void load(item.path, 1)}
                    disabled={!item.isDirectory || isLoading || Boolean(creatingPath)}
                    title={item.name}
                  >
                    <strong>{item.name}</strong>
                    <small>{item.isDirectory ? "文件夹" : formatFileSize(item.size)}</small>
                  </button>
                  {item.isDirectory ? (
                    <button
                      className="webdav-enter-button"
                      type="button"
                      onClick={() => void load(item.path, 1)}
                      disabled={isLoading || Boolean(creatingPath)}
                      aria-label={`进入 ${item.name}`}
                    >
                      <ChevronRight size={18} />
                    </button>
                  ) : item.isVideo ? (
                    <button
                      className="webdav-create-button"
                      type="button"
                      onClick={() => void createFromFile(item)}
                      disabled={isLoading || Boolean(creatingPath)}
                    >
                      {creatingPath === item.path
                        ? <><LoaderCircle className="spin-icon" size={14} /> 创建中</>
                        : <><CirclePlay size={14} /> 创建房间</>}
                    </button>
                  ) : (
                    <span className="webdav-unsupported">不可播放</span>
                  )}
                </div>
              ))}
            </div>

            <div className="webdav-pagination">
              <button
                type="button"
                onClick={() => void load(listing.path, listing.page - 1)}
                disabled={listing.page <= 1 || isLoading || Boolean(creatingPath)}
              >
                <ChevronLeft size={15} /> 上一页
              </button>
              <span>第 {listing.page} / {listing.totalPages} 页</span>
              <button
                type="button"
                onClick={() => void load(listing.path, listing.page + 1)}
                disabled={listing.page >= listing.totalPages || isLoading || Boolean(creatingPath)}
              >
                下一页 <ChevronRight size={15} />
              </button>
            </div>
          </div>
        )}

        {error && <p className="webdav-error" role="alert">{error}</p>}
      </section>
    </div>
  );
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
  const [webdavOpen, setWebdavOpen] = useState(false);
  const [error, setError] = useState("");

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setError("");
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
      enterCreatedRoom(response, nickname);
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

            {sourceType === "video" && (
              <button className="webdav-open-button" type="button" onClick={() => setWebdavOpen(true)}>
                <HardDrive size={16} />
                <span><strong>从 WebDAV 选择</strong><small>分页浏览视频并一键开房</small></span>
                <ChevronRight size={16} />
              </button>
            )}

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
                <span>你的昵称 <em>选填</em></span>
                <input
                  type="text"
                  maxLength={16}
                  placeholder="留空将随机生成"
                  value={nickname}
                  onChange={(event) => setNickname(event.target.value)}
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

      {webdavOpen && (
        <WebDavBrowser
          nickname={nickname}
          roomTitle={title}
          roomPassword={password}
          onClose={() => setWebdavOpen(false)}
        />
      )}

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
