/**
 * 图鉴页：这一局里你"认识"的人，以及你对他们的读数。
 *
 * 数据全部来自服务端 `GET /api/v1/rooms/:roomId/gallery`（docs/03 §5.2.5）：
 * 面板不读 `WorldState.entities[].attrs`、不出现任何属性键、不自己算分档（I2 / issue #3）。
 * - `display: "exact"` → 标签 + 数值 + 进度条（public）
 * - `display: "band"` → 只给三档体感（secret；self 对他人也只给分档）
 * - `display: "text"` → 文本行（public 文本）
 * - `display: "masked"` → 「—」（不可见或玩法尚未写入）
 */
import { useEffect, useState } from "react";
import { fetchGallery } from "./api-gallery.ts";
import type { Band, GalleryNpc, GalleryStat, GalleryView } from "./api-gallery.ts";

const BAND_CLS: Record<Band, string> = { 低: "calm", 中: "wary", 高: "tense" };

function StatRow({ stat }: { stat: GalleryStat }) {
  if (stat.display === "text") {
    return (
      <div className="row">
        <dt>{stat.label}</dt>
        <dd>{stat.text}</dd>
      </div>
    );
  }
  if (stat.display === "band") {
    return (
      <div className="stat">
        <span className="stat-label">{stat.label}</span>
        <span className={`chip guard ${stat.band ? BAND_CLS[stat.band] : ""}`}>{stat.band ?? "—"}</span>
        <span className="stat-num muted">体感</span>
      </div>
    );
  }
  if (stat.display === "masked") {
    return (
      <div className="stat">
        <span className="stat-label">{stat.label}</span>
        <span className="stat-num muted">—</span>
      </div>
    );
  }
  return (
    <div className="stat">
      <span className="stat-label">{stat.label}</span>
      <div className="bar">
        <i style={{ width: `${(stat.ratio ?? 0) * 100}%` }} />
      </div>
      <span className="stat-num">
        {stat.value}
        {stat.unit ?? ""}
      </span>
    </div>
  );
}

function NpcCard({ npc }: { npc: GalleryNpc }) {
  return (
    <article className={`npc-card${npc.met ? "" : " locked"}`}>
      <header>
        <h3>{npc.met ? npc.name : "？？？"}</h3>
        <span className={`pill ${npc.present ? "published" : "approved"}`}>
          {npc.present ? "在场" : npc.met ? "在别处" : "未见面"}
        </span>
      </header>
      <div className="muted">{npc.met ? (npc.role ?? "身份不明") : "还没见过这个人"}</div>

      {npc.met ? (
        <>
          {(npc.traits?.length ?? 0) > 0 && (
            <div className="chips">
              {npc.traits?.map((t) => (
                <span className="chip tag" key={t}>
                  {t}
                </span>
              ))}
            </div>
          )}

          {npc.stats.map((s) => (
            <StatRow key={s.key} stat={s} />
          ))}

          <div className="row">
            <dt>位置</dt>
            <dd>{npc.present ? "就在你身边" : (npc.locName ?? "行踪不明")}</dd>
          </div>
          {npc.line && <p className="npc-line">「{npc.line}」</p>}
        </>
      ) : (
        <p className="muted npc-line">在校园里遇到他，这一页才会写下名字。</p>
      )}
    </article>
  );
}

export default function GalleryPanel({ roomId }: { roomId: string }) {
  const [gallery, setGallery] = useState<GalleryView | null>(null);
  const [err, setErr] = useState("");

  // 服务端是读数的唯一来源；切回图鉴（组件重挂载）或换房间时重新拉
  useEffect(() => {
    let alive = true;
    setGallery(null);
    setErr("");
    fetchGallery(roomId)
      .then((g) => {
        if (alive) setGallery(g);
      })
      .catch((e) => {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [roomId]);

  if (!gallery) {
    return (
      <div className="panel-note">
        <div className="muted">{err ? `图鉴读取失败：${err}` : "正在读取图鉴…"}</div>
      </div>
    );
  }

  return (
    <div className="gallery-panel">
      <div className="gallery-head">
        <div>
          <strong>人物图鉴</strong>
          <span className="muted">
            {" "}
            · 已遇见 {gallery.counts.met}/{gallery.counts.total} · 校园地点 {gallery.counts.locs}
          </span>
        </div>
        <span className="muted">遇到人（或和他同处一地）才会解锁；读数由服务端按玩法写入，随互动变化</span>
      </div>
      {err && <div className="err">{err}</div>}

      <div className="gallery-grid">
        {gallery.npcs.map((npc) => (
          <NpcCard key={npc.id} npc={npc} />
        ))}
      </div>
    </div>
  );
}
