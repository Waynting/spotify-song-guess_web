import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter } from "@/components/site-footer";
import { ServiceNotice } from "@/components/service-notice";

export const metadata: Metadata = {
  // Unlike the English pages, the H1 here IS the keyword — /zh is not the brand
  // landing page, so nothing has to be reserved for "GuessSong".
  title: "猜歌遊戲 — 用 Spotify 歌單玩的免費派對遊戲",
  description:
    "免費線上猜歌遊戲。貼上任何公開的 Spotify 歌單，播放 5 到 30 秒的片段，大家搶答歌名。不用登入、不用下載 App，聚會、尾牙、家庭聚餐都能玩。",
  keywords: [
    "猜歌遊戲",
    "猜歌",
    "線上猜歌",
    "spotify 猜歌",
    "音樂猜謎",
    "派對遊戲",
    "聚會遊戲",
    "團康遊戲",
    "尾牙遊戲",
  ],
  alternates: {
    canonical: "/zh",
    languages: { en: "/", "zh-TW": "/zh", "x-default": "/" },
  },
  openGraph: {
    title: "猜歌遊戲 — 用 Spotify 歌單玩的免費派對遊戲",
    description:
      "貼上 Spotify 歌單，播放歌曲片段，大家搶答歌名。不用登入、不用下載，打開就能玩。",
    locale: "zh_TW",
  },
};

const GITHUB_URL = "https://github.com/Waynting/GuessSong";

const STEPS = [
  {
    num: "01",
    title: "貼上歌單",
    desc: "複製任何公開 Spotify 歌單的分享連結貼進去就好。不用登入 Spotify、不用註冊帳號，遊戲會自動讀出歌單裡的曲目。",
  },
  {
    num: "02",
    title: "輸入玩家名字",
    desc: "把在場每個人的名字打進去。GuessSong 是同一個螢幕的團康遊戲：一個人當主持人，其他人對著螢幕搶答。",
  },
  {
    num: "03",
    title: "播放片段",
    desc: "主持人按下播放，隨機一首歌的片段就會響起，長度 5 到 30 秒自己選。沒有歌名、沒有封面，只有聲音。",
  },
  {
    num: "04",
    title: "搶答計分",
    desc: "大家直接喊出答案，主持人點一下最先答對的人。計分板會一路累積到分出勝負。",
  },
];

const FEATURES = [
  { emoji: "🔓", title: "免登入", desc: "不用 Spotify 帳號、不用註冊，打開網頁就能開始。" },
  { emoji: "🎧", title: "任何公開歌單", desc: "KTV 熱門、韓團、八零年代金曲，只要是公開歌單都能用。" },
  { emoji: "🔀", title: "混合歌單模式", desc: "每個人丟自己的歌單，合併成一池，猜猜這首是誰放的。" },
  { emoji: "⚡", title: "零安裝", desc: "沒有要下載的東西，遊戲進度都留在你自己的瀏覽器裡。" },
  { emoji: "🎚️", title: "難度自己調", desc: "高手玩 5 秒，輕鬆場開 30 秒。每輪要幾首也自己決定。" },
  { emoji: "📷", title: "掃 QR Code 加入", desc: "玩家用自己的手機掃碼，就能交出自己的歌單或按鈴搶答。" },
];

const FAQS: { q: string; a: string }[] = [
  {
    q: "猜歌遊戲怎麼玩？",
    a: "一個人當主持人、用一個螢幕就好。貼上公開的 Spotify 歌單、輸入大家的名字，遊戲會播放隨機一首歌 5 到 30 秒的片段。所有人直接喊出答案，主持人點一下最先答對的人：答對歌名 3 分，再答出專輯名多 1 分。",
  },
  {
    q: "需要 Spotify 帳號或登入嗎？",
    a: "不用。GuessSong 完全不需要登入，也沒有帳號要註冊。它只會讀取公開歌單的曲目清單，然後播放每首歌的試聽片段。",
  },
  {
    q: "要錢嗎？",
    a: "完全免費，而且是開源專案。沒有東西要安裝、沒有東西要付費，直接在瀏覽器裡跑。",
  },
  {
    q: "幾個人可以玩？",
    a: "一個螢幕圍得下幾個人就幾個人。主持人控制音樂和計分板，其他人負責聽和搶答。也可以開啟搶答器模式，讓玩家用自己的手機按鈴搶答。",
  },
  {
    q: "可以每個人都用自己的歌單嗎？",
    a: "可以，那就是混合歌單模式。每個人交出自己的歌單，GuessSong 會合併成一池並去掉重複的歌，猜中「這首是誰放的」還能加分。",
  },
  {
    q: "為什麼有些歌沒有聲音？",
    a: "Spotify 在 2024 年底停止提供大部分歌曲的試聽片段，所以 GuessSong 會改去 iTunes 和 Deezer 找。少數歌曲在哪裡都找不到片段就會被跳過，選擇主流一點的歌單通常效果最好。",
  },
];

function SpotifyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20" aria-hidden>
      <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden>
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

export default function ZhPage() {
  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "HowTo",
      inLanguage: "zh-TW",
      name: "猜歌遊戲怎麼玩",
      description: "把任何公開的 Spotify 歌單變成派對猜歌遊戲，四個步驟。",
      step: STEPS.map((s, i) => ({
        "@type": "HowToStep",
        position: i + 1,
        name: s.title,
        text: s.desc,
      })),
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      inLanguage: "zh-TW",
      mainEntity: FAQS.map((f) => ({
        "@type": "Question",
        name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    },
  ];

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Outfit:wght@300;400;500;600;700&display=swap');

        :root {
          --green: #1DB954;
          --bg: #111111;
          --surface: #1a1a1a;
          --surface2: #222222;
          --border: #2a2a2a;
          --text: #f0f0f0;
          --muted: #777;
        }

        body { background: var(--bg); font-family: 'Outfit', sans-serif; color: var(--text); }

        /* Bebas Neue has no CJK glyphs, so Chinese headings fall back to the
           system CJK face. Weight carries the hierarchy instead of the display
           font. */
        .zh-hero-title {
          font-size: clamp(2.4rem, 7vw, 4.2rem);
          font-weight: 700;
          letter-spacing: 0.04em;
          line-height: 1.15;
          background: linear-gradient(135deg, #ffffff 0%, #aaffc8 40%, #1DB954 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
        }
        .zh-section-title {
          font-size: clamp(1.4rem, 3.4vw, 2rem);
          font-weight: 700;
          letter-spacing: 0.03em;
          line-height: 1.3;
          color: var(--text);
        }
        .zh-eyebrow {
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.14em;
          color: var(--green);
        }
        .zh-lede {
          color: #999;
          font-size: 16px;
          font-weight: 300;
          line-height: 1.85;
          max-width: 540px;
          margin: 16px auto 0;
        }

        .card {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 16px;
        }

        .cta-primary {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 14px 28px;
          background: var(--green);
          color: #000;
          font-size: 16px;
          font-weight: 700;
          border-radius: 12px;
          text-decoration: none;
          letter-spacing: 0.03em;
          transition: background 0.15s, transform 0.1s, box-shadow 0.15s;
          box-shadow: 0 4px 24px rgba(29,185,84,0.3);
        }
        .cta-primary:hover {
          background: #1ed760;
          box-shadow: 0 4px 32px rgba(29,185,84,0.5);
          transform: translateY(-1px);
        }
        .cta-secondary {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 14px 28px;
          background: var(--surface2);
          color: var(--text);
          font-size: 16px;
          font-weight: 600;
          border: 1.5px solid var(--border);
          border-radius: 12px;
          text-decoration: none;
          transition: border-color 0.15s, transform 0.1s, background 0.15s;
        }
        .cta-secondary:hover {
          border-color: var(--green);
          background: rgba(29,185,84,0.06);
          transform: translateY(-1px);
        }

        .step-card { display: flex; gap: 18px; align-items: flex-start; padding: 22px 24px; }
        .step-num {
          font-family: 'Bebas Neue', sans-serif;
          font-size: 34px;
          line-height: 1;
          color: var(--green);
          opacity: 0.9;
          flex-shrink: 0;
          width: 44px;
        }
        .step-title { font-size: 17px; font-weight: 600; color: var(--text); margin-bottom: 6px; }
        .step-desc { font-size: 14px; color: #999; line-height: 1.85; font-weight: 300; }

        .feature-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
        .feature-card { padding: 20px; }
        .feature-emoji { font-size: 24px; margin-bottom: 10px; }
        .feature-title { font-size: 15px; font-weight: 600; color: var(--text); margin-bottom: 6px; }
        .feature-desc { font-size: 13px; color: #999; line-height: 1.8; font-weight: 300; }

        .score-row { display: flex; align-items: center; gap: 14px; padding: 16px 20px; }
        .score-pts {
          font-family: 'Bebas Neue', sans-serif;
          font-size: 28px;
          line-height: 1;
          color: var(--green);
          flex-shrink: 0;
          width: 58px;
        }
        .score-label { font-size: 14px; color: #ccc; line-height: 1.75; font-weight: 300; }
        .score-label strong { color: var(--text); font-weight: 600; }

        .faq-q { font-size: 15px; font-weight: 600; color: var(--text); margin-bottom: 6px; }
        .faq-a { font-size: 14px; color: #999; line-height: 1.85; font-weight: 300; }

        .link-btn {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 8px 16px;
          border-radius: 999px;
          border: 1.5px solid rgba(29,185,84,0.35);
          background: rgba(29,185,84,0.06);
          color: var(--green);
          font-size: 13px;
          font-weight: 600;
          text-decoration: none;
          /* 頁尾的「更新內容」是 <button>，和旁邊的 mailto <a> 排在同一行。
             button 不會繼承這兩個屬性。 */
          cursor: pointer;
          line-height: 1.2;
          transition: border-color 0.15s, background 0.15s;
        }
        .link-btn:hover { border-color: var(--green); background: rgba(29,185,84,0.12); }

        .noise-overlay {
          position: fixed;
          inset: 0;
          pointer-events: none;
          background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
          opacity: 0.025;
        }
      `}</style>

      <div className="noise-overlay" aria-hidden />

      {/* The root layout owns <html lang="en">, so scope the language here.
          hreflang in metadata is what Google actually keys off. */}
      <main
        lang="zh-Hant-TW"
        style={{
          minHeight: "100vh",
          display: "flex",
          justifyContent: "center",
          padding: "72px 20px 48px",
          position: "relative",
        }}
      >
        <div style={{ width: "100%", maxWidth: "760px", display: "flex", flexDirection: "column", gap: "72px" }}>

          <header style={{ textAlign: "center" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "10px", marginBottom: "14px" }}>
              <span style={{ color: "#1DB954", display: "inline-flex" }}>
                <SpotifyIcon />
              </span>
              <span style={{ fontSize: "13px", fontWeight: 500, color: "#777", letterSpacing: "0.08em" }}>
                免費開源派對遊戲
              </span>
            </div>
            <h1 className="zh-hero-title">猜歌遊戲</h1>
            <p className="zh-lede">
              貼上任何公開的 Spotify 歌單，播放一小段音樂，大家搶答歌名。
              不用登入、不用下載 App，一個螢幕加一群人就能開始。
            </p>
            <div style={{ display: "flex", gap: "12px", justifyContent: "center", flexWrap: "wrap", marginTop: "28px" }}>
              <Link href="/" className="cta-primary">開始遊戲 →</Link>
              {/* Points at "/" to match the en hreflang above — a switcher that
                  disagrees with the annotation is a mixed signal. */}
              <Link href="/" hrefLang="en" className="cta-secondary">English</Link>
            </div>
          </header>

          <section>
            <p className="zh-eyebrow" style={{ marginBottom: "10px" }}>怎麼玩</p>
            <h2 className="zh-section-title" style={{ marginBottom: "24px" }}>從歌單到開場，三十秒</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "12px" }}>
              {STEPS.map((step) => (
                <div key={step.num} className="card step-card">
                  <span className="step-num">{step.num}</span>
                  <div>
                    <p className="step-title">{step.title}</p>
                    <p className="step-desc">{step.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section>
            <p className="zh-eyebrow" style={{ marginBottom: "10px" }}>新功能 · 多人</p>
            <h2 className="zh-section-title" style={{ marginBottom: "14px" }}>混合歌單模式 🔀</h2>
            <p className="step-desc" style={{ maxWidth: "560px", marginBottom: "20px" }}>
              不用只放一個人的歌單。每個人交出自己的歌單，GuessSong 會合併成一池、
              去掉重複的歌，然後變成一場品味大戰：你分得出這首是誰放的嗎？
              遊戲結束還能下載一張「品味卡」，看看大家的共同愛歌，以及誰的品味最冷門、誰最主流。
            </p>
          </section>

          <section>
            <p className="zh-eyebrow" style={{ marginBottom: "10px" }}>計分</p>
            <h2 className="zh-section-title" style={{ marginBottom: "14px" }}>主持人就是裁判</h2>
            <p className="step-desc" style={{ maxWidth: "560px", marginBottom: "20px" }}>
              不用打字、不用跟自動選字吵架。玩家直接喊出答案，主持人點一下最先答對的人。
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              <div className="card score-row">
                <span className="score-pts">+3</span>
                <span className="score-label"><strong>歌名。</strong>第一個喊出歌名的人拿大分。</span>
              </div>
              <div className="card score-row">
                <span className="score-pts">+1</span>
                <span className="score-label"><strong>專輯名。</strong>連專輯都知道的鐵粉加分。</span>
              </div>
              <div className="card score-row">
                <span className="score-pts">+2</span>
                <span className="score-label"><strong>這是誰的歌單？</strong>混合歌單模式限定，猜中是誰放的再加分。</span>
              </div>
            </div>
          </section>

          <section>
            <p className="zh-eyebrow" style={{ marginBottom: "10px" }}>為什麼用 GuessSong</p>
            <h2 className="zh-section-title" style={{ marginBottom: "24px" }}>為了聚會而做，不是為了收帳號</h2>
            <div className="feature-grid">
              {FEATURES.map((f) => (
                <div key={f.title} className="card feature-card">
                  <div className="feature-emoji" aria-hidden>{f.emoji}</div>
                  <p className="feature-title">{f.title}</p>
                  <p className="feature-desc">{f.desc}</p>
                </div>
              ))}
            </div>
          </section>

          <section>
            <p className="zh-eyebrow" style={{ marginBottom: "10px" }}>常見問題</p>
            <h2 className="zh-section-title" style={{ marginBottom: "24px" }}>大家最常問的</h2>
            <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
              {FAQS.map((faq) => (
                <div key={faq.q}>
                  <h3 className="faq-q">{faq.q}</h3>
                  <p className="faq-a">{faq.a}</p>
                </div>
              ))}
            </div>
          </section>

          <section style={{ textAlign: "center" }}>
            <h2 className="zh-section-title" style={{ marginBottom: "14px" }}>準備好開場了嗎？</h2>
            <p className="step-desc" style={{ maxWidth: "420px", margin: "0 auto 24px" }}>
              GuessSong 免費且開源。如果它讓你的聚會更好玩，去 GitHub 給一顆星是最好的道謝方式。
            </p>
            <div style={{ display: "flex", gap: "12px", justifyContent: "center", flexWrap: "wrap" }}>
              <Link href="/" className="cta-primary">開始遊戲 →</Link>
              <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="cta-secondary">
                <span style={{ color: "#ffd75e", display: "inline-flex" }}><GitHubIcon /></span>
                在 GitHub 給星
              </a>
            </div>
          </section>

          <ServiceNotice locale="zh" />
          <SiteFooter locale="zh" />
        </div>
      </main>
    </>
  );
}
