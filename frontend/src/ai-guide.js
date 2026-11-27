// 「AI に使い方を聞く」。利用者が自分の AI（ChatGPT・Claude など）に使い方ガイドの URL を渡すと、
// 説明書として読んでもらえることを伝え、URL を頼み方の文ごとコピーする（種日和と同じ形）。
//
// **ガイドの中身の正本は geo/geo.config.json の guide**（`npm run geo` で frontend/llms-full.txt を作る）。
// ここには URL と頼み方の文だけを置く。URL が設定と食い違わないことは worker/test/ai-guide.test.ts が見る。
//
// **記録の貼り付けを誘わない。** 頼み方の例は使い方を聞く文だけにする（ガイドも AI に「記録を貼らせない」と頼んでいる）。
//
// カードは 2 つ: ログイン欄（使う前: 自分に合いそうかを聞く）と「AI相談」タブ（使い方を聞く）。
// 見出し・説明は index.html に静的に書き、ボタンの data-ai-guide に頼み方の種類（login / app）を書く。

/** 使い方ガイドの公開 URL。開発中も本番の URL を案内する（localhost は外の AI から読めない） */
export const AI_GUIDE_URL = 'https://pollenia.tomu-ai.dev/llms-full.txt';

/** そのまま AI に貼れる頼み方の文。URL を含む */
export const AI_GUIDE_PROMPTS = {
  login: `次の URL は「Pollenia」という植物の育種記録アプリの説明書です。読んでから、どんなアプリか、できることとしないこと、私に合いそうかを教えてください。\n${AI_GUIDE_URL}`,
  app: `次の URL は「Pollenia」という植物の育種記録アプリの説明書です。読んでから、使い方を教えてください。\n${AI_GUIDE_URL}`,
};

export const AI_GUIDE_COPIED = 'URL を頼み方の文と一緒にコピーしました。AI との会話に貼り付けてください。';
/** 端末によらない言い方（「長押し」は PC で通じない） */
export const AI_GUIDE_COPY_FAILED = 'コピーできませんでした。上の URL を選んでコピーしてください。';

/** ボタンに書いた種類 → 頼み方の文（知らない種類は null） */
export function promptFor(kind) {
  return Object.hasOwn(AI_GUIDE_PROMPTS, kind) ? AI_GUIDE_PROMPTS[kind] : null;
}

/** ページ内の「URL をコピー」ボタン（data-ai-guide）すべてに、コピーの動作を付ける */
export function initAiGuide(root = document) {
  for (const btn of root.querySelectorAll('button[data-ai-guide]')) {
    const prompt = promptFor(btn.dataset.aiGuide);
    const status = btn.parentElement.querySelector('[role="status"]');
    if (!prompt || !status) continue;
    btn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(prompt);
        status.textContent = AI_GUIDE_COPIED;
      } catch {
        // http の localhost 以外・権限なしなど。clipboard が無い環境もここに来る
        status.textContent = AI_GUIDE_COPY_FAILED;
      }
    };
  }
}
