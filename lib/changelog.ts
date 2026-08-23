/**
 * Player-facing release notes for the footer's "What's new" overlay.
 *
 * Deliberately *not* generated from CHANGELOG.md. That file is written for
 * whoever maintains this code — it talks about Durable Objects, KV round-trips
 * and function names, and its "Known gaps" sections are a maintainer's todo
 * list. This list is for someone who came here to play a party game and wants
 * to know what changed since last time. Both are hand-written, and a release
 * updates both.
 *
 * ## Why every line is bilingual
 *
 * `/zh` exists because the Chinese landing page is written natively rather than
 * translated (see CHANGELOG 0.4.0), and its footer says 回報問題, not "Report a
 * problem". An English-only overlay opening off that footer would undo the one
 * thing that page is for. So each entry carries both languages side by side,
 * as parallel fields rather than two separate lists — a missing translation is
 * then a type error at the callsite instead of a silent English fallback, and
 * a test asserts neither side is empty.
 *
 * Newest first. The overlay trusts that order: it reports `entries[0].version`
 * as the version a reader saw, so a release added out of order would attribute
 * its reads to the wrong version.
 */

export type ChangelogLocale = "en" | "zh";

/** How a line reads on the page. Purely presentational grouping. */
export type ChangeKind = "new" | "better" | "fixed";

export interface ChangelogChange {
  kind: ChangeKind;
  /** Plain text — the overlay does not render markdown. */
  text: string;
  /** Traditional Chinese. Written for a Chinese reader, not translated word for word. */
  textZh: string;
}

export interface ChangelogEntry {
  version: string;
  /** ISO date. Formatted by `formatChangelogDate`, never `toLocaleDateString` —
   *  see the note on that function. */
  date: string;
  /** One line on what this release was about. */
  headline: string;
  headlineZh: string;
  changes: ChangelogChange[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "1.7.2",
    date: "2026-08-23",
    headline:
      "When Spotify has cut the site off, you now find out before you paste a playlist instead of after you press Start.",
    headlineZh:
      "當 Spotify 把整個網站擋下來的時候，現在你在貼上歌單之前就會知道，而不是按下開始以後才發現。",
    changes: [
      {
        kind: "new",
        text: "A notice on the way in when new playlists are not loading. Spotify limits this whole site as one, so when its daily allowance runs out nobody can load anything new — and until now the only way to discover that was to paste a link, press Start, and be refused.",
        textZh: "當新歌單載入不了的時候，一進站就會看到公告。Spotify 是把整個網站當成一個來限制的，所以它的每日額度用完時，任何人都載不了新歌單 —— 而在此之前，唯一發現的方法是貼上連結、按下開始，然後被拒絕。",
      },
      {
        kind: "better",
        text: "The notice takes itself down. It reads the same signal the game does, so the moment Spotify starts answering again it is gone, without anybody having to remember to remove it.",
        textZh: "這個公告會自己消失。它讀的是遊戲本身在讀的同一個訊號，所以 Spotify 一恢復回應它就不見了，不需要任何人記得回來把它拿掉。",
      },
      {
        kind: "better",
        text: "Players joining a mixed-playlist room see it too, since their submission goes through the same place. A room that quietly collected nothing was the worst version of this.",
        textZh: "加入混合歌單房間的玩家也看得到，因為他們送出的歌單走的是同一條路。房間安安靜靜什麼都沒收到，是這件事最糟的版本。",
      },
      {
        kind: "new",
        text: "The site now paces how many new playlists it loads from Spotify across the day, instead of using the allowance up as fast as it arrives. On a busy day that means a handful of hosts are asked to wait at the edges — which is the trade for not having Spotify shut every new playlist out for thirteen hours at a time, which is what happened this week.",
        textZh: "網站現在會把向 Spotify 載入新歌單的數量分配到一整天，而不是有多少就用多快。忙碌的日子裡，這代表少數幾位主持人會在邊緣被請稍等 —— 這是為了不要再被 Spotify 一次擋掉十三個小時所做的取捨，而那正是這週發生的事。",
      },
      {
        kind: "better",
        text: "Playlists you have already loaded keep working through all of this. Whatever is happening with Spotify, a party that has started is not interrupted by it.",
        textZh: "在這整個過程中，你已經載入過的歌單都還是能用。不管 Spotify 那邊發生什麼事，已經開始的派對不會被打斷。",
      },
    ],
  },
  {
    version: "1.7.1",
    date: "2026-08-23",
    headline:
      "Spotify cut the whole site off for a day, so loading a playlist now costs half as much and the message you get when it happens is honest.",
    headlineZh:
      "Spotify 一度把整個網站擋了一整天，所以現在載入歌單的成本少了一半，真的被擋的時候訊息也不再騙人。",
    changes: [
      {
        kind: "fixed",
        text: "Loading a playlist asks Spotify for half as much. Every game used to send two requests where one would do, which is a large part of why the shared allowance ran out in the first place.",
        textZh: "載入歌單時跟 Spotify 要的東西少了一半。以前每一場遊戲都送出兩個請求，其實一個就夠了 —— 那正是共用額度會被用完的一大原因。",
      },
      {
        kind: "better",
        text: "A playlist you used last night loads instantly tonight. They used to be forgotten after six hours, which is just short enough to miss the gap between two parties.",
        textZh: "昨晚用過的歌單，今晚一秒就開得起來。以前只記住六個小時，而六個小時剛好差一點，接不上兩場派對之間的間隔。",
      },
      {
        kind: "fixed",
        text: "When Spotify does refuse everyone, you are told what actually happened instead of a countdown. The old message promised a wait of a few minutes even when the real answer was the next day, so you would come back and be told the same thing again.",
        textZh: "當 Spotify 真的把所有人擋下來時，你看到的是實話，而不是一個倒數。以前的訊息說再等幾分鐘就好，就算實際上要等到隔天 —— 於是你回來以後，只會再被告知一次同樣的幾分鐘。",
      },
      {
        kind: "better",
        text: "Playlists already loaded keep working while that is going on, so a party in the middle of a game is not interrupted by someone else starting one.",
        textZh: "在那期間，已經載入過的歌單照常能玩 —— 玩到一半的派對不會因為別人剛好要開一場而被打斷。",
      },
    ],
  },
  {
    version: "1.7.0",
    date: "2026-08-21",
    headline:
      "There is now a guides section, and every page carries a proper footer with a privacy policy and terms.",
    headlineZh: "新增了遊戲指南專區，每一頁的頁尾也都有了完整的隱私權政策與服務條款。",
    changes: [
      {
        kind: "new",
        text: "Guides. Eight longer pieces on running one of these evenings: how to host a music quiz night, how to pick a playlist that actually plays well, what clip length does to a room, how to score a game so the last round still matters, and what to do when a Spotify playlist refuses to load. Linked from the footer of every page.",
        textZh: "遊戲指南。八篇比較長的文章，講的是怎麼把一場猜歌之夜辦好：怎麼主持、怎麼挑一個真的適合猜的歌單、片段長度會怎麼改變整個房間的氣氛、分數要怎麼算最後一輪才還有意義，以及歌單讀不出來的時候該怎麼辦。每一頁的頁尾都能進去。",
      },
      {
        kind: "new",
        text: "A privacy policy, terms of use and a contact page — the privacy policy and terms in both English and Chinese. The privacy policy says exactly what is stored and for how long, which for a game with no accounts is a shorter list than you might expect.",
        textZh: "新增隱私權政策、服務條款和聯絡頁面，其中隱私權政策與服務條款都有中英文版本。隱私權政策明確寫出什麼東西會被存下來、存多久 —— 對一個沒有帳號的遊戲來說，這份清單比你想的短。",
      },
      {
        kind: "better",
        text: "One footer everywhere. The homepage, the how-to-play page and the Chinese page used to each have their own; now they share one, so the links to the policies, the guides and the release notes are in the same place on every page.",
        textZh: "頁尾全站統一。首頁、玩法說明頁和中文頁以前各有各的頁尾，現在共用同一個 —— 政策、指南和更新說明的連結，在每一頁都在同一個位置。",
      },
    ],
  },
  {
    version: "1.6.0",
    date: "2026-08-15",
    headline:
      "Mixed Playlist games now hand the merged playlist back at the end, and tell you how the guessing actually went.",
    headlineZh: "混合歌單模式現在會在結束時把合併好的歌單交還給你，並告訴你這一場猜得如何。",
    changes: [
      {
        kind: "new",
        text: "Copy the Mix. At the end of a Mixed Playlist game there is a button that copies the whole merged tracklist, with each song credited to whoever brought it, ready to paste into your group chat. Anyone who submitted a playlist is named even if none of their songs made the cut — they turned up, so they are on the list.",
        textZh: "「複製這份混音」。混合歌單模式結束時多了一個按鈕，會把合併後的完整曲目複製起來，每首歌都標著是誰帶來的，可以直接貼到群組裡。有交歌單但一首都沒被抽到的人也會列在名單上 —— 人有來，名字就在。",
      },
      {
        kind: "new",
        text: "A line under the final scores saying how many songs nobody could name and how many were traced back to the right playlist. Two parties can end on the same scoreboard having had completely different evenings, and this is the part the scoreboard cannot show.",
        textZh: "最終比分下面多了一行，寫著有幾首歌全場都叫不出名字、有幾首被猜對了出處。兩場派對可能以一樣的比分收場，過程卻完全不同，而那正是比分表看不出來的部分。",
      },
      {
        kind: "fixed",
        text: "The taste card no longer prints an empty AWARDS heading when a group shares no songs and no awards can be worked out — which is exactly what happens when everyone's music comes from somewhere different.",
        textZh: "當一群人完全沒有重疊的歌、算不出任何獎項時，品味卡不會再印出一個空的 AWARDS 標題 —— 而那正好是每個人的音樂各來自一方時會發生的情況。",
      },
      {
        kind: "fixed",
        text: "\"Most obscure taste\" used to go to whoever submitted their playlist first whenever nobody guessed anyone's songs correctly. It now goes to whoever brought the most songs that nobody could place.",
        textZh: "以前只要全場都沒人猜對任何人的歌，「最冷門品味」就會頒給最早交歌單的那個人。現在會頒給帶了最多首、而且沒人認得出來的那一位。",
      },
    ],
  },
  {
    version: "1.5.0",
    date: "2026-08-13",
    headline:
      "You can now pick any number of songs, and the sample playlists on the home page are gone.",
    headlineZh: "現在可以自己決定要玩幾首歌，首頁的範例歌單則已移除。",
    changes: [
      {
        kind: "new",
        text: "Number of Songs has a box you can type into. The buttons are still there for 10, 20, 30, 50 or the whole playlist, but if you want a 7-song round before dinner, type 7. Anything up to 500 works, and a shorter playlist simply plays every track it has.",
        textZh:
          "「歌曲數量」多了一個可以自己輸入的欄位。10、20、30、50 和整份歌單的按鈕都還在，但如果你想在晚餐前玩個 7 首，直接輸入 7 就好。最多可以到 500 首；歌單比你輸入的數字短的話，就把它整份播完。",
      },
      {
        kind: "better",
        text: "The three sample playlists on the home page have been removed, along with the solo round they started. GuessSong is a game for a room full of people, and the home page now says only that: paste a playlist, add names, play.",
        textZh:
          "首頁上的三份範例歌單已經移除，連同它們開啟的單人模式一起。GuessSong 是給一屋子人一起玩的遊戲，首頁現在只講這件事：貼上歌單、加入名字、開始玩。",
      },
    ],
  },
  {
    version: "1.4.0",
    date: "2026-08-13",
    headline:
      "Rooms are steadier when a crowd scans at once, and the whole app leans much less on its storage.",
    headlineZh:
      "一群人同時掃碼時房間更穩，整個 app 對儲存空間的用量也降了一大截。",
    changes: [
      {
        kind: "fixed",
        text: "When several people submitted a playlist at the same instant — which is what happens when everyone scans the QR code together — one of them could quietly go missing from the room. Two people can no longer end up sharing one name either.",
        textZh:
          "好幾個人同一瞬間送出歌單時——大家一起掃 QR code 就是這樣——其中一個人可能會悄悄從房間裡消失。現在也不會再有兩個人共用同一個名字。",
      },
      {
        kind: "better",
        text: "Last month the site went down because our storage hit its monthly limit. We went through everything that touches it: the room screen now checks less often once nobody new is arriving, and the parts that fetch song clips stopped asking the same question over and over. Same game, a fraction of the usage.",
        textZh:
          "上個月網站掛掉，是因為儲存空間用完了當月額度。我們把所有會用到它的地方重新檢查過一遍：沒有新人加入時，房間畫面就不再一直查詢；抓歌曲片段的部分也不會再重複問同一個問題。玩法完全一樣，用量只剩一小部分。",
      },
      {
        kind: "better",
        text: "The room list still updates just as fast while people are joining — it only slows down after a stretch where nobody new has arrived, and speeds straight back up the moment someone does.",
        textZh:
          "有人陸續加入的時候，房間名單更新速度跟以前一模一樣；只有在一段時間都沒有新人時才會放慢，而且一有人加入就立刻恢復。",
      },
    ],
  },
  {
    version: "1.3.2",
    date: "2026-08-13",
    headline:
      "Playlists load again, and a mixed game now plays the full number of songs you picked.",
    headlineZh:
      "歌單恢復正常，混合歌單也會照你選的首數播好播滿。",
    changes: [
      {
        kind: "fixed",
        text: "For a while no playlist would load at all, and the message blamed your link. The link was fine — our storage had hit its monthly limit and the whole site went down with it. The game now keeps working when that happens.",
        textZh:
          "有一陣子不管貼什麼歌單都讀不進來，畫面還叫你檢查連結。連結沒問題，是我們的儲存空間用完了當月額度，整個網站跟著掛掉。現在就算再發生一次，遊戲也照常玩得下去。",
      },
      {
        kind: "fixed",
        text: "Mixed Playlist games were quietly shorter than the number you asked for, and the more taste two players shared the shorter it got — two people who like the same music could pick 8 songs each and get 12 instead of 16. Now it fills up to the full amount.",
        textZh:
          "混合歌單以前會偷偷變短，而且兩個人口味越接近就越短——都選每人 8 首，最後可能只播到 12 首而不是 16 首。現在會補滿到你選的數量。",
      },
      {
        kind: "better",
        text: "Once a room has expired or the game has started, the app stops checking on it. Before, a forgotten tab kept asking about that room all day.",
        textZh:
          "房間過期或遊戲開始之後，就不再繼續查詢它的狀態。之前忘了關的分頁會整天一直問下去。",
      },
    ],
  },
  {
    version: "1.3.1",
    date: "2026-08-10",
    headline:
      "When a playlist will not open, the game says so straight away instead of making you wait for the same answer twice.",
    headlineZh:
      "遇到打不開的歌單，現在會馬上告訴你，不用再等一次一樣的答案。",
    changes: [
      {
        kind: "better",
        text: "Tapping Start again on a playlist we cannot open now answers instantly. Before, every tap went off and came back with the same message.",
        textZh:
          "歌單打不開時再按一次「開始遊戲」，會立刻顯示原因。以前每按一次都要重新問一遍，再回來給你同樣的訊息。",
      },
      {
        kind: "better",
        text: "The app icons and the preview image on shared links are now made ahead of time, so pages and shared links open faster.",
        textZh:
          "App 圖示和分享連結的預覽圖改成事先做好，開啟頁面或點開分享連結都更快。",
      },
    ],
  },
  {
    version: "1.3.0",
    date: "2026-08-09",
    headline:
      "If you played on someone else's phone, you can now find your way back — the game finally tells you what it is called.",
    headlineZh:
      "在別人的房間玩過之後，現在找得到回來的路了 —— 這個遊戲總算會告訴你它叫什麼名字。",
    changes: [
      {
        kind: "new",
        text: "The Game Over screen now shows a QR code. Everyone in the room already has their phone out from buzzing, so anyone who wants to run the next party can just point it at the screen.",
        textZh:
          "遊戲結束的畫面現在會顯示一個 QR code。大家搶答完手機本來就還在手上，誰想主辦下一場，對著螢幕掃一下就好。",
      },
      {
        kind: "new",
        text: "Saved result cards carry a QR code too. Until now a card you sent to a group chat said the name of the game and nothing else, so anyone it reached had to already know where to find us.",
        textZh:
          "存下來的成績卡也帶著 QR code 了。以前傳到群組裡的卡片只寫了遊戲名字，收到的人得本來就知道去哪裡找我們才行。",
      },
      {
        kind: "better",
        text: "The buzzer and playlist pages on your phone now say what this is and link back to it. They used to be a dead end: you buzzed, the game ended, and the page never mentioned the name at all.",
        textZh:
          "手機上的搶答頁和交歌單頁，現在會說明這是什麼並附上連結。以前那是死路：你按完搶答鈕、遊戲結束，那個頁面從頭到尾沒提過名字。",
      },
    ],
  },
  {
    version: "1.2.0",
    date: "2026-08-09",
    headline:
      "The clip you hear is now the recording on the answer card — not a cover, and not some other song that happened to share the title.",
    headlineZh:
      "現在放出來的片段，就是答案卡上的那個版本 —— 不是翻唱，也不是剛好同名的另一首歌。",
    changes: [
      {
        kind: "fixed",
        text: "Sometimes the clip that played was the wrong recording. We looked songs up by title and took whatever came back first, so a cover version, or an unrelated song with the same name, could win — asking for Adele's Hello could get you a children's version of it. Worse, we remembered that answer for a year. We now check the artist and the exact length of the track before playing anything, and if neither lines up we say there is no audio rather than play you something wrong.",
        textZh:
          "有時候放出來的片段根本是別的版本。以前我們用歌名去找，回來第一個就拿來用，所以翻唱版、或是剛好同名的另一首歌都可能被選中 —— 想聽 Adele 的 Hello，放出來的可能是兒歌版。更糟的是，這個錯誤答案會被記住一年。現在我們會先確認歌手，還會比對歌曲的精確長度，兩個都對不上就寧可顯示沒有音檔，也不放錯的給你。",
      },
      {
        kind: "better",
        text: "Chinese, Japanese and Korean songs are matched far more reliably. The music services we get clips from usually list them under an English name, so checking the artist alone never worked for them — the length of a recording, though, is the same number in every language, and that is what we now compare.",
        textZh:
          "中文、日文、韓文歌的比對準確度大幅提升。我們取得片段的音樂服務通常會用英文名稱收錄這些歌，所以光比對歌手名字對它們從來沒用過 —— 但一首錄音的長度，在哪個語言裡都是同一個數字，現在我們比的是這個。",
      },
    ],
  },
  {
    version: "1.1.0",
    date: "2026-08-03",
    headline:
      "Fewer songs turn up silent, and the ones that do play start faster. Plus the messages you get when something goes wrong are finally in your own language.",
    headlineZh:
      "更少歌變成沒聲音，會響的也響得更快。另外，出狀況時跳出來的訊息，終於是用你看得懂的語言寫的了。",
    changes: [
      {
        kind: "fixed",
        text: "Songs that showed up as \"no audio\" often had audio all along. When lots of people were playing at once, the service we get clips from would tell us to slow down — and we wrote that down as \"this song has no clip\" and stopped asking for a week. Now we tell the two apart, and a song is only written off when it really has nothing.",
        textZh:
          "以前顯示「沒有音檔」的歌，很多其實是有的。同時上線的人一多，提供試聽片段的服務就會要我們慢一點，而我們把那句話記成了「這首歌沒有試聽」，然後整整一週不再問。現在這兩件事分得清楚了，只有真的找不到才會被放棄。",
      },
      {
        kind: "better",
        text: "The clips for a whole game are now fetched the moment you land on the game screen, instead of one at a time as you play. The first Play is quicker, and a bad moment on the internet no longer lands on you mid-round.",
        textZh:
          "整場遊戲的試聽片段，現在一進遊戲畫面就一次抓齊，不再是玩到哪抓到哪。第一次按播放更快，網路不順的時候也不會剛好卡在你正在出題的那一輪。",
      },
      {
        kind: "better",
        text: "If a clip goes quiet because its link expired, the game fetches a fresh one and carries on instead of skipping the round.",
        textZh:
          "如果某首歌的試聽連結過期而沒聲音，遊戲會自己去換一條新的接著播，而不是整輪跳過。",
      },
      {
        kind: "fixed",
        text: "Playlists that refused to load at busy times. Spotify limits how much the whole site can ask for, not how much you can, so one person's playlist could fail because of everyone else's. We now remember playlists we have already seen, and when we do get told to wait, we say so instead of telling you your link is wrong.",
        textZh:
          "尖峰時段歌單讀不出來的問題。Spotify 限制的是整個網站的總用量，不是你個人的，所以你的歌單可能因為別人而失敗。現在看過的歌單會被記住，真的被要求等待時也會照實說，而不是叫你去檢查自己的連結。",
      },
      {
        kind: "better",
        text: "Every error message now appears in Chinese or English depending on the phone reading it — so a guest scanning someone else's QR code can read what went wrong, whichever language the host uses.",
        textZh:
          "所有錯誤訊息現在會依照每台手機自己的語言顯示中文或英文，所以掃別人 QR code 加入的朋友，不管主持人用哪種語言，都看得懂發生了什麼事。",
      },
      {
        kind: "better",
        text: "Very long playlists now draw their songs randomly from the whole list instead of always taking the first few hundred, so the same playlist gives you a different game each time.",
        textZh:
          "很長的歌單現在會從整份清單裡隨機抽歌，不再每次都拿最前面那幾百首，所以同一份歌單每次玩到的歌都不一樣。",
      },
    ],
  },
  {
    version: "1.0.0",
    date: "2026-07-30",
    headline:
      "GuessSong 1.0. The party game, Buzzer Mode, Mixed Playlist Mode and the Chinese site are all finished — this release names that rather than adding to it.",
    headlineZh:
      "GuessSong 1.0 正式版。派對遊戲、搶答模式、混合歌單模式、中文版都完成了，這一版是為它們正式定名，而不是又加了什麼。",
    changes: [
      {
        kind: "new",
        text: "This panel. Every release from now on gets a plain-language note here, in English and Chinese, from the footer of any page.",
        textZh:
          "你正在看的這個視窗。從這一版開始，每次更新都會在這裡留下一段人話說明，中英文都有，任何頁面的頁尾都打得開。",
      },
      {
        kind: "better",
        text: "The QR code flow is now measured end to end. A code people scan but fail to get through shows up as something to fix, instead of quietly looking like nobody scanned it.",
        textZh:
          "掃 QR code 加入房間的每一步現在都量得到了。以前有人掃了卻卡在表單上，數字看起來跟沒人掃一模一樣；現在卡住會被看見，才修得到。",
      },
    ],
  },
  {
    version: "0.4.0",
    date: "2026-07-29",
    headline: "Easier to find, and now readable in Chinese.",
    headlineZh: "更好找，而且看得懂中文了。",
    changes: [
      {
        kind: "new",
        text: "A Traditional Chinese version of the site at /zh — written natively rather than machine-translated.",
        textZh: "/zh 的繁體中文版本，是直接用中文寫的，不是機器翻譯過來的。",
      },
      {
        kind: "better",
        text: "The homepage now explains how the game actually works, and answers the six questions people ask most, instead of being a form and one paragraph.",
        textZh:
          "首頁現在會好好說明遊戲怎麼玩，也回答了大家最常問的六個問題，不再只是一個輸入框加一段話。",
      },
    ],
  },
  {
    version: "0.3.0",
    date: "2026-07-29",
    headline: "Everyone gets a buzzer.",
    headlineZh: "每個人都有一顆搶答鈕。",
    changes: [
      {
        kind: "new",
        text: "Buzzer Mode — every player buzzes in from their own phone, so the host can stop refereeing “who said it first” and actually play. The host buzzes with the space bar.",
        textZh:
          "搶答模式：每個人用自己的手機搶答，主持人不用再當裁判判「誰先講的」，可以真的一起玩。主持人按空白鍵搶答。",
      },
      {
        kind: "new",
        text: "One QR code for everything. Buzzer Mode and Mixed Playlist Mode used to hand out two different codes on two different pages; players now scan once and get both.",
        textZh:
          "一個 QR code 就搞定。以前搶答模式和混合歌單模式會給兩組不同的房間代碼、兩個不同的頁面，現在掃一次兩個都有。",
      },
      {
        kind: "new",
        text: "The host can add their own playlist in Mixed Playlist Mode. They are holding the screen everyone else is scanning, so they could never scan it themselves.",
        textZh:
          "主持人在混合歌單模式裡也能加自己的歌單了。他們拿的正是大家要掃的那塊螢幕，本來根本掃不到自己。",
      },
      {
        kind: "better",
        text: "Buzzing in pauses the clip so the room can hear the answer, and Resume, Stop and Replay stay available until you reveal it.",
        textZh:
          "有人搶答時音樂會自動暫停，大家才聽得到答案；在公布答案之前，繼續播、停止、重播都還按得到。",
      },
      {
        kind: "better",
        text: "A wrong answer passes the question down to whoever buzzed next, instead of ending the round.",
        textZh: "答錯不會直接結束這一題，而是把機會往下傳給下一個搶到的人。",
      },
      {
        kind: "better",
        text: "The room code now appears after the settings, not before them — it is the last step, when it is genuinely time to gather people.",
        textZh:
          "房間代碼現在排在所有設定之後才出現。它是最後一步，等真的要把人叫過來的時候才需要。",
      },
      {
        kind: "fixed",
        text: "Correct and Wrong did nothing at all once the answer had been revealed.",
        textZh: "公布答案之後，「答對」和「答錯」按了完全沒反應。",
      },
    ],
  },
  {
    version: "0.2.0",
    date: "2026-07-12",
    headline: "Play with everyone's music, not just the host's.",
    headlineZh: "放大家的歌，不只是主持人的歌。",
    changes: [
      {
        kind: "new",
        text: "Mixed Playlist Mode — everyone adds their own playlist, GuessSong merges them into one round and drops the duplicates. Pass the host's phone around, or let people scan a QR code from their own.",
        textZh:
          "混合歌單模式：每個人加自己的歌單，GuessSong 會合成一份並去掉重複的歌。可以把主持人的手機傳一輪，也可以讓大家用自己的手機掃 QR code。",
      },
      {
        kind: "new",
        text: "A bonus point for guessing whose playlist a track came from.",
        textZh: "猜中這首歌是誰的歌單裡的，可以多拿分。",
      },
      {
        kind: "new",
        text: "A shareable Taste Card at the end of a mixed game: the tracks you all had, most obscure taste, and most mainstream.",
        textZh:
          "混合歌單玩完會產生一張可以分享的音樂品味卡：大家都有的歌、品味最冷門的人、最主流的人。",
      },
      {
        kind: "fixed",
        text: "Two players submitting a playlist at the same moment could quietly overwrite each other.",
        textZh: "兩個人同時送出歌單時，其中一份會被默默蓋掉。",
      },
    ],
  },
];

/** The newest release. Used as the `version` on the `changelog_opened` event. */
export const LATEST_VERSION = CHANGELOG[0].version;

/** Every string the overlay renders that isn't release content. */
export const CHANGELOG_UI: Record<
  ChangelogLocale,
  {
    trigger: string;
    title: string;
    currentVersion: string;
    close: string;
    kinds: Record<ChangeKind, string>;
    footnotePrefix: string;
    footnoteSuffix: string;
  }
> = {
  en: {
    trigger: "What's new",
    title: "What's new",
    currentVersion: "Currently on v",
    close: "Close what's new",
    kinds: { new: "New", better: "Better", fixed: "Fixed" },
    footnotePrefix: "Older releases and the full technical history live in ",
    footnoteSuffix: " in the repo.",
  },
  zh: {
    trigger: "更新內容",
    title: "更新內容",
    currentVersion: "目前版本 v",
    close: "關閉更新內容",
    kinds: { new: "新增", better: "改善", fixed: "修正" },
    footnotePrefix: "更早的版本和完整的技術紀錄都在原始碼的 ",
    footnoteSuffix: " 裡。",
  },
};

/** Pick a change's text for a locale. Keeps the ternary out of the JSX. */
export function changeText(change: ChangelogChange, locale: ChangelogLocale): string {
  return locale === "zh" ? change.textZh : change.text;
}

export function entryHeadline(entry: ChangelogEntry, locale: ChangelogLocale): string {
  return locale === "zh" ? entry.headlineZh : entry.headline;
}

/**
 * Format an ISO date without going through `toLocaleDateString`.
 *
 * The locale-aware formatters resolve against the *runtime's* locale and time
 * zone, which differ between the Node process that prerenders these pages and
 * the browser that hydrates them — React reports that as a hydration mismatch.
 * A fixed table has no such gap.
 */
export function formatChangelogDate(iso: string, locale: ChangelogLocale = "en"): string {
  const [year, month, day] = iso.split("-");
  if (locale === "zh") {
    return `${year} 年 ${Number(month)} 月 ${Number(day)} 日`;
  }
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${Number(day)} ${months[Number(month) - 1]} ${year}`;
}
