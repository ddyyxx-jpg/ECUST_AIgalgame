/**
 * 标题页：进游戏前的入口。
 * 展示世界观一句话、给按钮（选身份开局 / 继续 / 存档 / 说明 / 关于），显示契约版本。
 * 不持有任何权威状态：点"开始"才让 App 去建房。模型配置只在服务端管理端，玩家界面不提供入口。
 */
import { useEffect, useState } from "react";
import type { SaveEntry } from "./api.ts";
import type { SavesState } from "./use-saves.ts";
import type { Scenario } from "./scenarios.ts";
import { setSoundOn, soundOn } from "./sfx.ts";

export interface TitleScreenProps {
  /** 开局列表来自服务端 /api/v1/scenarios；空数组 = 无预设开局 */
  scenarios: Scenario[];
  /** 开局列表还在加载（区别于"加载失败后的空"） */
  scenariosLoading: boolean;
  /** 选定开局并新建一局 */
  onStart: (scenarioId: string) => void;
  /** 继续上次的房间；没有存档时传 null（按钮不渲染） */
  onResume: (() => void) | null;
  /** 上一次存下的房间号，仅用于按钮上的小字 */
  savedRoomId: string;
  /** 本人存档索引（issue #7）：加载/空/错误/无权限分开显示，不再静默当空列表 */
  savesState: SavesState;
  /** 从存档进房：与"继续上次"同一条恢复路径 */
  onOpenSave: (save: SaveEntry) => void;
  /** 只从列表移除索引，不删房间 */
  onDeleteSave: (save: SaveEntry) => void;
  busy: boolean;
  err: string;
  /** 当前登录账号（显示在右上角） */
  username: string;
  /** 退出登录：清会话并回到登录页 */
  onLogout: () => void;
}

type Panel = "none" | "choose" | "saves" | "help" | "about";

const HELP: { q: string; a: string }[] = [
  { q: "怎么玩", a: "在输入框里直接写你要做什么，不用选选项。例如「去图书馆找林老师问问昨天的传闻」。" },
  { q: "什么会被接受", a: "移动、观察、说话、买东西都可以试。数值和规则由服务端裁决，写出世界之外的事会被拒绝并告诉你原因。" },
  { q: "NPC 会记得吗", a: "每个 NPC 有自己的信任与戒备；夜里自主密谋与长期记忆在后续里程碑里。" },
  { q: "断线会丢吗", a: "不会。每个房间一份事件日志，从标题页「继续上次」就能回到原来的地方。" },
];

const ABOUT: { k: string; v: string }[] = [
  { k: "作品", v: "ECUST · AI 校园 —— 校园题材的 AI 文字游戏" },
  { k: "设计", v: "AI 只能提议，引擎才能记账；加玩法只加数据，不改引擎" },
  { k: "技术", v: "TypeScript 全栈 · 事件日志存档 · 12 个操作原语" },
  { k: "团队", v: "shuaqiTeam" },
];

/** 存档面板的非列表状态：各自给一句人话，而不是看起来像"没有存档" */
function SavesNotice({ state }: { state: SavesState }) {
  if (state.status === "loading" || state.status === "idle") {
    return <p className="panel-note">正在加载存档…</p>;
  }
  if (state.status === "unauthorized") {
    return <p className="panel-note">请先登录后再查看存档。</p>;
  }
  if (state.status === "forbidden") {
    return <p className="panel-note">没有权限读取存档（403）。请联系管理员。</p>;
  }
  if (state.status === "error") {
    return <p className="panel-note">无法加载存档：{state.error}</p>;
  }
  return <p className="panel-note">还没有存档——进入游戏玩一回合后，这里就会出现。</p>;
}

export default function TitleScreen({
  scenarios,
  scenariosLoading,
  onStart,
  onResume,
  savedRoomId,
  savesState,
  onOpenSave,
  onDeleteSave,
  busy,
  err,
  username,
  onLogout,
}: TitleScreenProps) {
  const [panel, setPanel] = useState<Panel>("none");
  const [version, setVersion] = useState("");
  const [sfx, setSfx] = useState(soundOn);

  // 契约版本从服务端拿，拿不到就不显示（不写死，免得文档改了这里过期）
  useEffect(() => {
    let alive = true;
    fetch("/api/v1/health")
      .then((r) => r.json() as Promise<{ ok?: boolean; contract?: string }>)
      .then((d) => {
        if (alive && typeof d.contract === "string") setVersion(d.contract);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const pad = (n: number) => String(n).padStart(2, "0");
  const saves = savesState.saves;

  const items: { id: string; label: string; hint: string; primary?: boolean; onClick: () => void }[] = [
    {
      id: "choose",
      label: "进入游戏",
      hint: "新的学期 · 新房间",
      primary: true,
      onClick: () => setPanel("choose"),
    },
  ];
  if (onResume) {
    items.push({ id: "resume", label: "继续上次", hint: savedRoomId, onClick: onResume });
  }
  items.push({
    id: "saves",
    label: "我的存档",
    hint:
      savesState.status === "ready" && saves.length > 0
        ? `${saves.length} 个房间 · 从上次的对话继续`
        : savesState.status === "loading" || savesState.status === "idle"
          ? "正在加载…"
          : savesState.status === "ready"
            ? "还没有存档"
            : "加载失败，点开查看",
    onClick: () => setPanel("saves"),
  });

  return (
    <div className="title-screen screen-in">
      <div className="title-grid" aria-hidden="true" />
      <div className="title-auth">
        <span className="muted">{username}</span>
        <button type="button" className="btn ghost" onClick={onLogout}>
          退出
        </button>
      </div>

      <div className="title-card">
        <p className="title-mark">ECUST · 奉贤校区 · 九月</p>
        <h1 className="title-name">
          AI <span>校园</span>
        </h1>
        <p className="title-sub">一所学校，一群有私心的 NPC，一个不会被选项框住的玩家。</p>

        {panel === "none" ? (
          <div className="title-menu">
            {items.map((item, i) => (
              <button
                key={item.id}
                type="button"
                className={`title-btn${item.primary ? " primary" : ""}`}
                onClick={item.onClick}
                disabled={busy}
              >
                <span className="k">{pad(i + 1)}</span>
                <span className="t">{busy && item.primary ? "正在开局…" : item.label}</span>
                <span className="h">{item.hint}</span>
              </button>
            ))}
          </div>
        ) : (
          // 每个入口都是独立的"一步"：打开后主菜单整体收起，只留该步骤的内容与返回
          <div className="choose-view">
            {panel === "choose" && (
              <>
                <p className="title-mark">选择你的身份</p>
                <p className="muted scenario-note">世界是同一所学校；不同的是你站在哪一边。</p>
                {scenarios.length === 0 ? (
                  // 内容数据缺失/服务不可用时也允许开局：不编造文案，只提示并直接进
                  <div className="panel-note">
                    <p className="muted">
                      {scenariosLoading ? "正在载入开局…" : "无预设开局（服务端 /api/v1/scenarios 不可用）。"}
                    </p>
                    <button
                      type="button"
                      className="btn primary"
                      onClick={() => onStart("")}
                      disabled={busy || scenariosLoading}
                    >
                      直接开始
                    </button>
                  </div>
                ) : (
                  <div className="scenario-grid">
                    {scenarios.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        className="scenario-card"
                        onClick={() => onStart(s.id)}
                        disabled={busy}
                      >
                        <span className="scenario-face">
                          <img
                            src={`/portraits/hero-${s.id}.jpg`}
                            alt=""
                            onError={(e) => {
                              e.currentTarget.style.display = "none";
                            }}
                          />
                        </span>
                        <strong>{s.name}</strong>
                        <span className="muted">{s.role}</span>
                        <span className="scenario-tagline">{s.tagline}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}

            {panel === "saves" && (
              <>
                <p className="title-mark">我的存档</p>
                <p className="muted scenario-note">
                  存档索引跟随当前账号；「从列表移除」只移除入口，房间与对话历史仍保留，凭房间号还能回去。
                </p>
                {savesState.status !== "ready" || saves.length === 0 ? (
                  <SavesNotice state={savesState} />
                ) : (
                  <div className="save-list">
                    {saves.map((save) => {
                      const sc = scenarios.find((item) => item.id === save.scenarioId);
                      const when = new Date(save.updatedAt).toLocaleString();
                      return (
                        <div className="save-row" key={save.roomId}>
                          <div className="save-main">
                            <strong>{sc?.name ?? save.scenarioId}</strong>
                            <span className="muted">
                              {sc?.role ?? ""} · {when} · 已提交到 seq {save.lastCommittedSeq}
                            </span>
                            <span className="muted save-room">{save.roomId}</span>
                          </div>
                          <div className="draft-actions">
                            <button type="button" className="btn primary" disabled={busy} onClick={() => onOpenSave(save)}>
                              继续
                            </button>
                            <button
                              type="button"
                              className="btn ghost"
                              disabled={busy}
                              onClick={() => onDeleteSave(save)}
                              title="只从列表移除入口，房间与对话历史不会被删除"
                            >
                              从列表移除
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}

            {panel === "help" && (
              <>
                <p className="title-mark">玩法说明</p>
                <dl>
                  {HELP.map((h) => (
                    <div className="qa" key={h.q}>
                      <dt>{h.q}</dt>
                      <dd>{h.a}</dd>
                    </div>
                  ))}
                </dl>
              </>
            )}

            {panel === "about" && (
              <>
                <p className="title-mark">关于本作</p>
                <dl>
                  {ABOUT.map((row) => (
                    <div className="qa" key={row.k}>
                      <dt>{row.k}</dt>
                      <dd>{row.v}</dd>
                    </div>
                  ))}
                </dl>
              </>
            )}

            <button type="button" className="btn ghost choose-back" onClick={() => setPanel("none")}>
              ← 返回
            </button>
          </div>
        )}

        {err && <div className="err title-err">{err}</div>}
      </div>

      <div className="title-foot">
        <span className="muted">{version ? `契约版本 ${version}` : "服务未连接"}</span>
        <span className="title-foot-right">
          {/* 次要入口：小字放在页面下方，不占主菜单的注意力 */}
          <button type="button" className="footer-link" onClick={() => setPanel("help")}>
            玩法说明
          </button>
          <button type="button" className="footer-link" onClick={() => setPanel("about")}>
            关于本作
          </button>
          <button
            type="button"
            className={`sfx-toggle${sfx ? "" : " off"}`}
            onClick={() => {
              const next = !sfx;
              setSoundOn(next);
              setSfx(next);
            }}
            title={sfx ? "点击静音" : "点击开启音效"}
          >
            {sfx ? "♪ 音效开" : "♪ 已静音"}
          </button>
          <span className="muted">自然语言行动 · 存档即事件日志</span>
        </span>
      </div>
    </div>
  );
}