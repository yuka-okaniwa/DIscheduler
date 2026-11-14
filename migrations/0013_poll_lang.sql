-- 調整の言語（docs/design.md §6.12）。チャンネルに投稿するメッセージ（募集・お知らせ・リマインド）と、最初の回答の選択肢の言語。
-- 作成したときの主催者の Discord の言語で決める。これまでの調整は日本語
ALTER TABLE polls ADD COLUMN lang TEXT NOT NULL DEFAULT 'ja' CHECK (lang IN ('ja', 'en'));
