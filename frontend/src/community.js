// Pollenia コミュニティUI（Phase 2.5: タイムライン・フォロー・いいね・コメント）。
//
// セキュリティ（_docs/api.md・後退厳禁）:
//   - post / comment の content は API 層でサニタイズされない。UGC（本文・コメント・
//     表示名・bio・交配メモ）は必ず textContent で描画する（innerHTML 直挿し禁止）。
//   - crossing の展開可否はバックエンド（F6）で判定済み。post.crossing が null の
//     レスポンス（不可視 or 添付なし）では交配セクションを描画しない。
import { api, ApiError } from './api.js';

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 20;

// initCommunity で注入されるコンテキスト:
//   token()    … 現在の Supabase アクセストークン
//   me         … 自分の profile（/api/me の返却値）
//   switchTab  … タブ切り替え（app.js が実装）
let ctx = null;

let feedOffset = 0;
let profileUserId = null;
let profileOffset = 0;

function errText(e) {
  return e instanceof ApiError ? `${e.message}（${e.code}）` : String(e?.message ?? e);
}

function setError(id, err) {
  $(id).textContent = err ? errText(err) : '';
}

function formatDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ja-JP');
}

export function initCommunity(context) {
  ctx = context;
  bindHandlers();
  loadCrossingOptions();
  refreshFeed();
}

// ログイン中ユーザーのプロフィールを開く（app.js のナビから呼ばれる）
export function openMyProfile() {
  openProfile(ctx.me.id);
}

function bindHandlers() {
  $('btn-create-post').onclick = createPost;
  $('btn-feed-more').onclick = () => loadMoreFeed().catch((e) => setError('feed-error', e));
  $('btn-profile-more').onclick = () =>
    loadMoreProfilePosts().catch((e) => setError('profile-error', e));
  $('btn-open-profile').onclick = () => {
    const id = $('profile-open-id').value.trim();
    setError('profile-open-error', null);
    if (!id) return;
    openProfile(id).catch((e) => setError('profile-open-error', e));
  };
  $('btn-followers').onclick = () => toggleFollowList('followers');
  $('btn-following').onclick = () => toggleFollowList('following');
}

// ---- 投稿フォーム -----------------------------------------------------------

// 添付候補は自分の交配記録のみ（API 側も他人の crossing_id を拒否する）。
// 交配記録を新規作成したら app.js から再呼び出しされる。
export async function loadCrossingOptions() {
  try {
    const { crossings } = await api.listCrossings(ctx.token());
    const sel = $('post-crossing');
    sel.replaceChildren();
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '（添付しない）';
    sel.appendChild(none);
    for (const c of crossings) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = `${c.seed_parent_name ?? '?'} × ${c.pollen_parent_name ?? '（父不明）'}${
        c.cross_date ? `（${c.cross_date}）` : ''
      }`;
      sel.appendChild(opt);
    }
  } catch (e) {
    setError('post-error', e);
  }
}

async function createPost() {
  setError('post-error', null);
  $('post-notice').textContent = '';
  const content = $('post-content').value.trim();
  if (!content) return setError('post-error', new Error('本文を入力してください。'));
  try {
    const body = { content, visibility: $('post-visibility').value };
    if ($('post-crossing').value) body.crossing_id = $('post-crossing').value;
    await api.createPost(ctx.token(), body);
    $('post-content').value = '';
    $('post-crossing').value = '';
    // フィードはフォロー中ユーザーの投稿のみ（自分の投稿は含まれない）ため、
    // 確認導線としてプロフィールタブを案内する
    $('post-notice').textContent = '投稿しました。自分の投稿は「プロフィール」タブで確認できます。';
  } catch (e) {
    setError('post-error', e);
  }
}

// ---- タイムライン -----------------------------------------------------------

async function refreshFeed() {
  feedOffset = 0;
  $('feed-list').replaceChildren();
  setError('feed-error', null);
  await loadMoreFeed().catch((e) => setError('feed-error', e));
}

async function loadMoreFeed() {
  const { posts } = await api.feed(ctx.token(), { limit: PAGE_SIZE, offset: feedOffset });
  const first = feedOffset === 0;
  feedOffset += posts.length;
  for (const p of posts) $('feed-list').appendChild(renderPost(p));
  $('feed-empty').classList.toggle('hidden', !(first && posts.length === 0));
  $('btn-feed-more').classList.toggle('hidden', posts.length < PAGE_SIZE);
}

// ---- 投稿の描画（フィード・プロフィール共用） --------------------------------

function renderPost(post) {
  const el = document.createElement('article');
  el.className = 'post';

  const head = document.createElement('div');
  head.className = 'post-head';
  const author = document.createElement('button');
  author.className = 'author-link';
  author.textContent = post.author_display_name ?? '（不明なユーザー）';
  author.onclick = () => openProfile(post.user_id);
  head.appendChild(author);
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = formatDate(post.created_at);
  head.appendChild(meta);
  const badge = document.createElement('span');
  // class 名はレスポンス値を直接使わず既知の enum に照合する（Opus 4.8 レビュー指摘）
  const vis = ['public', 'followers', 'private'].includes(post.visibility) ? post.visibility : '';
  badge.className = `badge ${vis}`;
  badge.textContent = post.visibility;
  head.appendChild(badge);
  el.appendChild(head);

  const body = document.createElement('div');
  body.className = 'post-content';
  body.textContent = post.content; // UGC: textContent 必須
  el.appendChild(body);

  // F6: crossing はバックエンドが可視と判定した場合のみ含まれる。null なら描画しない
  if (post.crossing) el.appendChild(renderCrossing(post.crossing));

  const foot = document.createElement('div');
  foot.className = 'post-foot';

  const likeBtn = document.createElement('button');
  likeBtn.className = 'small ghost like';
  let liked = post.liked_by_viewer;
  let likeCount = post.like_count;
  const paintLike = () => {
    likeBtn.textContent = `${liked ? '♥' : '♡'} ${likeCount}`;
    likeBtn.classList.toggle('active', liked);
  };
  paintLike();
  likeBtn.onclick = async () => {
    likeBtn.disabled = true;
    try {
      if (liked) {
        await api.unlikePost(ctx.token(), post.id);
        liked = false;
        // DELETE は like_count を返さないためローカルで減算
        likeCount = Math.max(0, likeCount - 1);
      } else {
        const r = await api.likePost(ctx.token(), post.id);
        liked = true;
        likeCount = r.like_count;
      }
      paintLike();
    } catch (e) {
      alert(errText(e));
    } finally {
      likeBtn.disabled = false;
    }
  };
  foot.appendChild(likeBtn);

  const commentBtn = document.createElement('button');
  commentBtn.className = 'small ghost';
  let commentCount = post.comment_count;
  const paintComments = () => {
    commentBtn.textContent = `💬 ${commentCount}`;
  };
  paintComments();
  foot.appendChild(commentBtn);
  el.appendChild(foot);

  const commentsArea = document.createElement('div');
  commentsArea.className = 'comments hidden';
  el.appendChild(commentsArea);
  let commentsLoaded = false;
  commentBtn.onclick = async () => {
    commentsArea.classList.toggle('hidden');
    if (commentsLoaded || commentsArea.classList.contains('hidden')) return;
    commentsLoaded = true;
    try {
      await mountComments(post.id, commentsArea, () => {
        commentCount += 1;
        paintComments();
      });
    } catch (e) {
      commentsLoaded = false;
      alert(errText(e));
    }
  };

  return el;
}

function renderCrossing(c) {
  const box = document.createElement('div');
  box.className = 'crossing-box';
  const title = document.createElement('div');
  title.textContent = `🌱 交配: ${c.seed_parent_name ?? '?'} × ${c.pollen_parent_name ?? '（父不明）'}`;
  box.appendChild(title);
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = [c.cross_date, c.notes].filter(Boolean).join(' — ');
  if (meta.textContent) box.appendChild(meta);
  return box;
}

// ---- コメント ----------------------------------------------------------------

async function mountComments(postId, container, onAdded) {
  container.replaceChildren();
  const list = document.createElement('div');
  container.appendChild(list);

  const { comments } = await api.listComments(ctx.token(), postId);
  for (const c of comments) list.appendChild(renderComment(c));

  const form = document.createElement('div');
  form.className = 'comment-form';
  const input = document.createElement('textarea');
  input.maxLength = 2000;
  input.placeholder = 'コメントを書く…（2000文字以内）';
  const send = document.createElement('button');
  send.className = 'small';
  send.textContent = '送信';
  send.onclick = async () => {
    const content = input.value.trim();
    if (!content) return;
    send.disabled = true;
    try {
      const { comment } = await api.createComment(ctx.token(), postId, content);
      list.appendChild(renderComment(comment));
      input.value = '';
      onAdded();
    } catch (e) {
      alert(errText(e));
    } finally {
      send.disabled = false;
    }
  };
  form.appendChild(input);
  form.appendChild(send);
  container.appendChild(form);
}

function renderComment(c) {
  const el = document.createElement('div');
  el.className = 'comment';
  const head = document.createElement('div');
  const author = document.createElement('button');
  author.className = 'author-link';
  author.textContent = c.author_display_name ?? '（不明なユーザー）';
  author.onclick = () => openProfile(c.user_id);
  head.appendChild(author);
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = ` ${formatDate(c.created_at)}`;
  head.appendChild(meta);
  el.appendChild(head);
  const body = document.createElement('div');
  body.className = 'post-content';
  body.textContent = c.content; // UGC: textContent 必須
  el.appendChild(body);
  return el;
}

// ---- プロフィール・フォロー ----------------------------------------------------

export async function openProfile(userId) {
  ctx.switchTab('profile');
  profileUserId = userId;
  profileOffset = 0;
  setError('profile-error', null);
  $('follow-list').classList.add('hidden');
  $('profile-posts').replaceChildren();
  $('profile-posts-empty').classList.add('hidden');
  $('btn-profile-more').classList.add('hidden');

  try {
    const { profile } = await api.getUser(ctx.token(), userId);
    $('profile-name').textContent = profile.display_name;
    $('profile-bio').textContent = profile.bio ?? '';
    $('follower-count').textContent = profile.follower_count;
    $('following-count').textContent = profile.following_count;

    const btn = $('btn-follow-toggle');
    if (userId === ctx.me.id) {
      btn.classList.add('hidden');
    } else {
      btn.classList.remove('hidden');
      paintFollowButton(btn, profile.followed_by_viewer);
    }

    await loadMoreProfilePosts();
  } catch (e) {
    setError('profile-error', e);
  }
}

function paintFollowButton(btn, following) {
  btn.textContent = following ? 'フォロー中（解除する）' : 'フォローする';
  btn.classList.toggle('ghost', following);
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      if (following) await api.unfollow(ctx.token(), profileUserId);
      else await api.follow(ctx.token(), profileUserId);
      // フォロー状態・フォロワー数・可視投稿（followers 分）が変わるため再読込
      await openProfile(profileUserId);
      await refreshFeed();
    } catch (e) {
      setError('profile-error', e);
    } finally {
      btn.disabled = false;
    }
  };
}

async function loadMoreProfilePosts() {
  const { posts } = await api.listUserPosts(ctx.token(), profileUserId, {
    limit: PAGE_SIZE,
    offset: profileOffset,
  });
  const first = profileOffset === 0;
  profileOffset += posts.length;
  for (const p of posts) $('profile-posts').appendChild(renderPost(p));
  $('profile-posts-empty').classList.toggle('hidden', !(first && posts.length === 0));
  $('btn-profile-more').classList.toggle('hidden', posts.length < PAGE_SIZE);
}

async function toggleFollowList(direction) {
  const box = $('follow-list');
  if (!box.classList.contains('hidden') && box.dataset.direction === direction) {
    box.classList.add('hidden');
    return;
  }
  box.dataset.direction = direction;
  box.classList.remove('hidden');
  box.replaceChildren();
  try {
    const { users } =
      direction === 'followers'
        ? await api.listFollowers(ctx.token(), profileUserId)
        : await api.listFollowing(ctx.token(), profileUserId);
    const title = document.createElement('div');
    title.className = 'meta';
    title.textContent = direction === 'followers' ? 'フォロワー' : 'フォロー中';
    box.appendChild(title);
    if (users.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'notice';
      empty.textContent = 'まだいません。';
      box.appendChild(empty);
      return;
    }
    for (const u of users) {
      const row = document.createElement('div');
      row.className = 'follow-user';
      const name = document.createElement('button');
      name.className = 'author-link';
      name.textContent = u.display_name; // UGC: textContent 必須
      name.onclick = () => openProfile(u.id);
      row.appendChild(name);
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = formatDate(u.followed_at);
      row.appendChild(meta);
      box.appendChild(row);
    }
  } catch (e) {
    setError('profile-error', e);
  }
}
