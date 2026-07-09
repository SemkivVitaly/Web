/**
 * @fileoverview Инициализация SQLite (`better-sqlite3`): каталог `data/`, путь из `SQLITE_PATH`, WAL и внешние ключи.
 * При загрузке модуля выполняется создание базовой схемы и цепочка идемпотентных миграций (`ALTER` / `CREATE IF NOT EXISTS`).
 * Синглтон БД отдаётся через `getDb()`.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = process.env.SQLITE_PATH || path.join(dataDir, 'localchat.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// --- Начальная схема (новая БД) ---

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    tag TEXT NOT NULL UNIQUE COLLATE NOCASE,
    bio TEXT DEFAULT '',
    avatar_file TEXT,
    notifications_enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS friendships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(from_user_id, to_user_id)
  );

  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    password_hash TEXT,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS group_members (
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','moderator','member')),
    banned_until TEXT,
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (group_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS group_invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    inviter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invitee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(group_id, invitee_id)
  );

  CREATE TABLE IF NOT EXISTS group_bans (
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    banned_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (group_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_group_bans_group ON group_bans(group_id);

  CREATE TABLE IF NOT EXISTS direct_conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_low_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_high_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_low_id, user_high_id),
    CHECK (user_low_id < user_high_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
    direct_id INTEGER REFERENCES direct_conversations(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL DEFAULT '',
    pinned_at TEXT,
    reply_to_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    edited_at TEXT,
    forward_preview_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (
      (group_id IS NOT NULL AND direct_id IS NULL) OR
      (group_id IS NULL AND direct_id IS NOT NULL)
    )
  );

  CREATE TABLE IF NOT EXISTS message_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('image','file','audio','video','voice')),
    transcript TEXT,
    office_revision INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS message_mentions (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS message_reactions (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (message_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS user_message_important (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, message_id)
  );

  CREATE TABLE IF NOT EXISTS user_chat_prefs (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_kind TEXT NOT NULL CHECK (chat_kind IN ('group','direct')),
    chat_id INTEGER NOT NULL,
    pinned_list INTEGER NOT NULL DEFAULT 0,
    favorite INTEGER NOT NULL DEFAULT 0,
    last_read_message_id INTEGER,
    PRIMARY KEY (user_id, chat_kind, chat_id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_direct ON messages(direct_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_reactions_msg ON message_reactions(message_id);
  CREATE INDEX IF NOT EXISTS idx_friendships_users ON friendships(from_user_id, to_user_id);

  CREATE TABLE IF NOT EXISTS collab_folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    parent_id INTEGER REFERENCES collab_folders(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    password_hash TEXT,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS collab_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    folder_id INTEGER REFERENCES collab_folders(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    doc_type TEXT NOT NULL CHECK (doc_type IN ('richtext','spreadsheet')),
    password_hash TEXT,
    y_state BLOB,
    created_by INTEGER NOT NULL REFERENCES users(id),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS task_boards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    password_hash TEXT,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id INTEGER NOT NULL REFERENCES task_boards(id) ON DELETE CASCADE,
    parent_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','review','done')),
    progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
    quantity_target INTEGER,
    quantity_done INTEGER NOT NULL DEFAULT 0,
    assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS task_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    uploaded_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS task_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_collab_group ON collab_documents(group_id);
  CREATE INDEX IF NOT EXISTS idx_collab_folders_group ON collab_folders(group_id, parent_id);
  CREATE INDEX IF NOT EXISTS idx_task_board_group ON task_boards(group_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_board ON tasks(board_id, parent_id, sort_order);
`);

// --- Миграции на уже существующих файлах БД ---

try {
  const taskCols = db.prepare(`PRAGMA table_info(tasks)`).all();
  if (!taskCols.some((c) => c.name === 'created_by')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN created_by INTEGER REFERENCES users(id)`);
  }
  let tCols = db.prepare(`PRAGMA table_info(tasks)`).all();
  if (!tCols.some((c) => c.name === 'quantity_target')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN quantity_target INTEGER`);
  }
  tCols = db.prepare(`PRAGMA table_info(tasks)`).all();
  if (!tCols.some((c) => c.name === 'quantity_done')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN quantity_done INTEGER NOT NULL DEFAULT 0`);
  }
} catch {
  /* ignore */
}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      action TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_task_activity_task ON task_activity(task_id, id DESC);
  `);
} catch {
  /* ignore */
}

try {
  let msgCols = db.prepare(`PRAGMA table_info(messages)`).all();
  if (!msgCols.some((c) => c.name === 'reply_to_id')) {
    db.exec(
      `ALTER TABLE messages ADD COLUMN reply_to_id INTEGER REFERENCES messages(id) ON DELETE SET NULL`
    );
    msgCols = db.prepare(`PRAGMA table_info(messages)`).all();
  }
  if (!msgCols.some((c) => c.name === 'edited_at')) {
    db.exec(`ALTER TABLE messages ADD COLUMN edited_at TEXT`);
  }
  msgCols = db.prepare(`PRAGMA table_info(messages)`).all();
  if (!msgCols.some((c) => c.name === 'forward_preview_json')) {
    db.exec(`ALTER TABLE messages ADD COLUMN forward_preview_json TEXT`);
  }
} catch {
  /* ignore */
}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS collab_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      parent_id INTEGER REFERENCES collab_folders(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      password_hash TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_collab_folders_group ON collab_folders(group_id, parent_id);
  `);
  let collabCols = db.prepare(`PRAGMA table_info(collab_documents)`).all();
  if (!collabCols.some((c) => c.name === 'description')) {
    db.exec(`ALTER TABLE collab_documents ADD COLUMN description TEXT NOT NULL DEFAULT ''`);
  }
  collabCols = db.prepare(`PRAGMA table_info(collab_documents)`).all();
  if (!collabCols.some((c) => c.name === 'folder_id')) {
    db.exec(`ALTER TABLE collab_documents ADD COLUMN folder_id INTEGER REFERENCES collab_folders(id) ON DELETE SET NULL`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_collab_docs_folder ON collab_documents(folder_id)`);
  collabCols = db.prepare(`PRAGMA table_info(collab_documents)`).all();
  if (!collabCols.some((c) => c.name === 'office_revision')) {
    db.exec(`ALTER TABLE collab_documents ADD COLUMN office_revision INTEGER NOT NULL DEFAULT 0`);
  }
  collabCols = db.prepare(`PRAGMA table_info(collab_documents)`).all();
  if (!collabCols.some((c) => c.name === 'task_board_only')) {
    db.exec(`ALTER TABLE collab_documents ADD COLUMN task_board_only INTEGER NOT NULL DEFAULT 0`);
  }
  collabCols = db.prepare(`PRAGMA table_info(collab_documents)`).all();
  if (!collabCols.some((c) => c.name === 'preview_stored_name')) {
    db.exec(`ALTER TABLE collab_documents ADD COLUMN preview_stored_name TEXT`);
  }
} catch {
  /* ignore */
}

try {
  let gCols = db.prepare(`PRAGMA table_info(groups)`).all();
  if (!gCols.some((c) => c.name === 'join_code')) {
    db.exec(`ALTER TABLE groups ADD COLUMN join_code TEXT`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_join_code ON groups(join_code) WHERE join_code IS NOT NULL`);
  }
  gCols = db.prepare(`PRAGMA table_info(groups)`).all();
  if (!gCols.some((c) => c.name === 'forward_locked')) {
    db.exec(`ALTER TABLE groups ADD COLUMN forward_locked INTEGER NOT NULL DEFAULT 0`);
  }
  gCols = db.prepare(`PRAGMA table_info(groups)`).all();
  if (!gCols.some((c) => c.name === 'invite_policy')) {
    db.exec(`ALTER TABLE groups ADD COLUMN invite_policy TEXT NOT NULL DEFAULT 'all'`);
  }
} catch {
  /* ignore */
}

try {
  let mCols = db.prepare(`PRAGMA table_info(messages)`).all();
  if (mCols.length && !mCols.some((c) => c.name === 'thread_root_id')) {
    db.exec(
      `ALTER TABLE messages ADD COLUMN thread_root_id INTEGER REFERENCES messages(id) ON DELETE SET NULL`
    );
  }
} catch {
  /* ignore */
}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      actor_user_id INTEGER NOT NULL REFERENCES users(id),
      action TEXT NOT NULL,
      target_kind TEXT,
      target_id INTEGER,
      meta_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_group ON audit_log (target_kind, target_id, id DESC);
  `);
} catch {
  /* ignore */
}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_workspace_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      link_kind TEXT NOT NULL CHECK (link_kind IN ('task','collab_document')),
      entity_id INTEGER NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(message_id, link_kind, entity_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mwl_message ON message_workspace_links(message_id);
    CREATE INDEX IF NOT EXISTS idx_mwl_task ON message_workspace_links(link_kind, entity_id);
  `);
} catch {
  /* ignore */
}

try {
  let uCols = db.prepare(`PRAGMA table_info(users)`).all();
  if (!uCols.some((c) => c.name === 'notifications_enabled')) {
    db.exec(`ALTER TABLE users ADD COLUMN notifications_enabled INTEGER NOT NULL DEFAULT 1`);
  }
  let prefCols = db.prepare(`PRAGMA table_info(user_chat_prefs)`).all();
  if (prefCols.length && !prefCols.some((c) => c.name === 'last_read_message_id')) {
    db.exec(`ALTER TABLE user_chat_prefs ADD COLUMN last_read_message_id INTEGER`);
  }
  prefCols = db.prepare(`PRAGMA table_info(user_chat_prefs)`).all();
  if (prefCols.length && !prefCols.some((c) => c.name === 'mute_notifications')) {
    db.exec(
      `ALTER TABLE user_chat_prefs ADD COLUMN mute_notifications INTEGER NOT NULL DEFAULT 0`
    );
  }
  prefCols = db.prepare(`PRAGMA table_info(user_chat_prefs)`).all();
  if (prefCols.length && !prefCols.some((c) => c.name === 'last_read_at')) {
    db.exec(`ALTER TABLE user_chat_prefs ADD COLUMN last_read_at TEXT`);
  }
  prefCols = db.prepare(`PRAGMA table_info(user_chat_prefs)`).all();
  if (prefCols.length && !prefCols.some((c) => c.name === 'hidden')) {
    db.exec(`ALTER TABLE user_chat_prefs ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0`);
  }
} catch {
  /* ignore */
}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_read_receipts (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      read_at TEXT NOT NULL,
      PRIMARY KEY (message_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_msg_read_receipts_msg ON message_read_receipts(message_id);
  `);
} catch {
  /* ignore */
}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_board_canvas_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id INTEGER NOT NULL REFERENCES task_boards(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('folder','task','upload','collab_doc','link')),
      title TEXT NOT NULL DEFAULT '',
      task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
      collab_document_id INTEGER REFERENCES collab_documents(id) ON DELETE CASCADE,
      file_stored_name TEXT,
      file_original_name TEXT,
      file_mime TEXT,
      link_url TEXT,
      parent_item_id INTEGER REFERENCES task_board_canvas_items(id) ON DELETE SET NULL,
      position_x REAL NOT NULL DEFAULT 48,
      position_y REAL NOT NULL DEFAULT 48,
      z_index INTEGER NOT NULL DEFAULT 1,
      pinned INTEGER NOT NULL DEFAULT 0,
      width REAL NOT NULL DEFAULT 220,
      height REAL NOT NULL DEFAULT 132,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_board_canvas_board ON task_board_canvas_items(board_id);
    CREATE INDEX IF NOT EXISTS idx_board_canvas_parent ON task_board_canvas_items(board_id, parent_item_id);
  `);
} catch {
  /* ignore */
}

try {
  const ci = db.prepare(`PRAGMA table_info(task_board_canvas_items)`).all();
  if (ci.length && !ci.some((c) => c.name === 'link_url')) {
    db.exec(`
      PRAGMA foreign_keys=OFF;
      BEGIN TRANSACTION;
      CREATE TABLE task_board_canvas_items_mig (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        board_id INTEGER NOT NULL REFERENCES task_boards(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('folder','task','upload','collab_doc','link')),
        title TEXT NOT NULL DEFAULT '',
        task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
        collab_document_id INTEGER REFERENCES collab_documents(id) ON DELETE CASCADE,
        file_stored_name TEXT,
        file_original_name TEXT,
        file_mime TEXT,
        link_url TEXT,
        parent_item_id INTEGER,
        position_x REAL NOT NULL DEFAULT 48,
        position_y REAL NOT NULL DEFAULT 48,
        z_index INTEGER NOT NULL DEFAULT 1,
        pinned INTEGER NOT NULL DEFAULT 0,
        width REAL NOT NULL DEFAULT 220,
        height REAL NOT NULL DEFAULT 132,
        created_by INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO task_board_canvas_items_mig (
        id, board_id, kind, title, task_id, collab_document_id, file_stored_name, file_original_name, file_mime,
        link_url, parent_item_id, position_x, position_y, z_index, pinned, width, height, created_by, created_at, updated_at
      )
      SELECT id, board_id, kind, title, task_id, collab_document_id, file_stored_name, file_original_name, file_mime,
        NULL, parent_item_id, position_x, position_y, z_index, pinned, width, height, created_by, created_at, updated_at
      FROM task_board_canvas_items;
      DROP TABLE task_board_canvas_items;
      ALTER TABLE task_board_canvas_items_mig RENAME TO task_board_canvas_items;
      CREATE INDEX IF NOT EXISTS idx_board_canvas_board ON task_board_canvas_items(board_id);
      CREATE INDEX IF NOT EXISTS idx_board_canvas_parent ON task_board_canvas_items(board_id, parent_item_id);
      COMMIT;
      PRAGMA foreign_keys=ON;
    `);
  }
} catch (e) {
  console.error('task_board_canvas_items link migration', e);
}

try {
  const mai = db.prepare(`PRAGMA table_info(message_attachments)`).all();
  if (mai.length && !mai.some((c) => c.name === 'office_revision')) {
    db.exec(`ALTER TABLE message_attachments ADD COLUMN office_revision INTEGER NOT NULL DEFAULT 0`);
  }
} catch {
  /* ignore */
}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS group_announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      author_id INTEGER NOT NULL REFERENCES users(id),
      body TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS announcement_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      announcement_id INTEGER NOT NULL REFERENCES group_announcements(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('image','file','audio','video','voice')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS announcement_acks (
      announcement_id INTEGER NOT NULL REFERENCES group_announcements(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('acknowledged','need_more')),
      comment TEXT,
      responded_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (announcement_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_group_announcements_group ON group_announcements(group_id);
    CREATE INDEX IF NOT EXISTS idx_announcement_acks_announcement ON announcement_acks(announcement_id);
  `);
} catch (e) {
  console.error('group_announcements migration', e);
}

try {
  const cols = db.prepare(`PRAGMA table_info(group_announcements)`).all();
  if (cols.length && !cols.some((c) => c.name === 'deleted_at')) {
    db.exec(`ALTER TABLE group_announcements ADD COLUMN deleted_at TEXT`);
  }
} catch (e) {
  console.error('group_announcements deleted_at migration', e);
}

try {
  const gaCols = db.prepare(`PRAGMA table_info(group_announcements)`).all();
  if (gaCols.length) {
    if (!gaCols.some((c) => c.name === 'kind')) {
      db.exec(`ALTER TABLE group_announcements ADD COLUMN kind TEXT NOT NULL DEFAULT 'notice'`);
    }
    if (!gaCols.some((c) => c.name === 'audience')) {
      db.exec(`ALTER TABLE group_announcements ADD COLUMN audience TEXT NOT NULL DEFAULT 'all'`);
    }
    if (!gaCols.some((c) => c.name === 'linked_task_id')) {
      db.exec(`ALTER TABLE group_announcements ADD COLUMN linked_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL`);
    }
    if (!gaCols.some((c) => c.name === 'due_at')) {
      db.exec(`ALTER TABLE group_announcements ADD COLUMN due_at TEXT`);
    }
    if (!gaCols.some((c) => c.name === 'quantity_target')) {
      db.exec(`ALTER TABLE group_announcements ADD COLUMN quantity_target INTEGER`);
    }
  }
} catch (e) {
  console.error('group_announcements extended migration', e);
}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS announcement_recipients (
      announcement_id INTEGER NOT NULL REFERENCES group_announcements(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (announcement_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_announcement_recipients_user ON announcement_recipients(user_id);
  `);
} catch (e) {
  console.error('announcement_recipients migration', e);
}

try {
  const ackCols = db.prepare(`PRAGMA table_info(announcement_acks)`).all();
  if (ackCols.length) {
    if (!ackCols.some((c) => c.name === 'task_status')) {
      db.exec(`ALTER TABLE announcement_acks ADD COLUMN task_status TEXT`);
    }
    if (!ackCols.some((c) => c.name === 'progress')) {
      db.exec(`ALTER TABLE announcement_acks ADD COLUMN progress INTEGER DEFAULT 0`);
    }
    if (!ackCols.some((c) => c.name === 'quantity_done')) {
      db.exec(`ALTER TABLE announcement_acks ADD COLUMN quantity_done INTEGER DEFAULT 0`);
    }
    if (!ackCols.some((c) => c.name === 'progress_note')) {
      db.exec(`ALTER TABLE announcement_acks ADD COLUMN progress_note TEXT`);
    }
  }
} catch (e) {
  console.error('announcement_acks extended migration', e);
}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS announcement_progress_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      announcement_id INTEGER NOT NULL REFERENCES group_announcements(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      task_status TEXT,
      progress INTEGER,
      quantity_done INTEGER,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_announcement_progress_log_ann ON announcement_progress_log(announcement_id);
  `);
} catch (e) {
  console.error('announcement_progress_log migration', e);
}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS assignment_mod_seen (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, group_id)
    );
  `);
} catch (e) {
  console.error('assignment_mod_seen migration', e);
}

try {
  const mai = db.prepare(`PRAGMA table_info(message_attachments)`).all();
  if (mai.length && !mai.some((c) => c.name === 'thumb_stored_name')) {
    db.exec(`ALTER TABLE message_attachments ADD COLUMN thumb_stored_name TEXT`);
  }
} catch (e) {
  console.error('message_attachments thumb_stored_name migration', e);
}

try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_msg_attachments_message ON message_attachments(message_id)`);
} catch (e) {
  console.error('idx_msg_attachments_message', e);
}

if (process.env.SQLITE_OPTIMIZE !== '0') {
  try {
    db.pragma('optimize');
  } catch (e) {
    console.warn('[db] PRAGMA optimize skipped:', e?.message || e);
  }
}

/** Единственный экземпляр `Database` процесса. */
export function getDb() {
  return db;
}
