# MigrationMaps: イラスト待ち枠(draft)の削除機能

## 背景

`/migrationmaps/admin` の「イラスト待ちの枠」パネル（`capturesListV2`）は、`GET
/api/migrationmaps/captures` が返す全キャプチャ（`draft` = イラスト未アップロード、
`ready` = イラスト紐づけ済み・公開中）を一覧表示している。誤って作成した枠や、
検証用に作った不要な `draft` 枠を削除する手段が現状ない。

## ゴール

- `draft` 状態のキャプチャ枠を管理画面から削除できるようにする。

## 非ゴール

- `ready`（公開済み）状態の枠の削除は対象外。公開URLが共有されている可能性があり、
  誤削除リスクが高いため今回のスコープから明示的に除外する。
- 削除に伴う店舗データ（`MigrationShop`）自体の削除は行わない（紐づけ解除のみ）。

## バックエンド設計

### `DELETE /api/migrationmaps/<int:project_id>`

- `MapProject.query.get(project_id)` が無ければ 404。
- `proj.status != "draft"` なら 400 + `{"error": "イラスト待ち(draft)の枠のみ削除できます"}`。
- 削除実行:
  - `MapPoint` は `MapProject.points` の `cascade="all, delete-orphan"` により
    ORM側で自動削除される（既存のリレーション定義のまま、変更不要）。
  - `MigrationShop.map_project_id` は FK が `ondelete="SET NULL"` のため、
    紐づく店舗があってもレコードは残り、`map_project_id` が `NULL` になる
    （店舗自体・店舗画像は削除されない）。
  - `db.session.delete(proj)` → `db.session.commit()`。失敗時は rollback して
    500 + `{"error": "DB削除に失敗しました", "detail": str(ex)}`。
- 成功レスポンス: `{"deleted": true, "project_id": project_id}`。

削除前に紐づく店舗件数をチェックする必要はない（フロントの確認ダイアログで
警告を出すのみで、バックエンドは無条件に許可する）。

## フロントエンド設計（`admin.js` / `admin.html`）

- `capturesListV2` の各行のアクション行に、`cap.status === "draft"` のときだけ
  「🗑 削除」ボタン（`btnDeleteCaptureV2`, `data-id`, `data-name`, `data-shopcount`）
  を追加する。`ready` 行には表示しない。
- クリックハンドラ（`capturesListV2` の既存 `click` リスナーに追記）:
  1. `data-shopcount > 0` なら
     `` `「${name}」を削除します。店舗${count}件の紐づけが解除されます（店舗自体は削除されません）。よろしいですか？` ``、
     0件なら `` `「${name}」を削除します。よろしいですか？` `` を `confirm()` で表示。
     キャンセルなら何もしない。
  2. `fetch(`/api/migrationmaps/${id}`, {method: "DELETE"})` を実行。
  3. 失敗時: 該当行の `illustrationErrorV2` 要素（draft行には既に存在する）に
     エラーメッセージを表示。
  4. 成功時:
     - `currentProjectId === id`（文字列/数値の型差異に注意して比較）であれば、
       既存の `resetToNew()`（[admin.js:1118](../../../static/migrationmaps/admin.js#L1118)）
       と同じパターンで `currentProjectId = null; updateShopTargetIndicator();`
       を呼び、対象選択インジケータを未選択表示に戻す。
     - `refreshCapturesV2()` で一覧を再描画。

## データフロー

```
[削除ボタンclick]
   -> confirm() (店舗件数に応じて文言変更)
   -> DELETE /api/migrationmaps/:id
        -> status確認(draft以外は400)
        -> MapPoint cascade削除 / MigrationShop.map_project_id を SET NULL
        -> MapProject削除 + commit
   -> 成功: 選択中対象なら解除 -> refreshCapturesV2()
   -> 失敗: 行内にエラー表示
```

## エラーハンドリング

| ケース | レスポンス |
|---|---|
| project_id が存在しない | 404 |
| `status != "draft"`（例: 二重クリック等で既にreadyになっていた） | 400 |
| DB例外 | 500 + rollback |
| ネットワーク/fetch失敗（フロント） | 行内にエラーメッセージ表示、一覧は再描画しない |

## テスト方針

- 手動確認（このリポジトリに migrationmaps 用の route レベル pytest ハーネスが
  無いため、既存の `docs/superpowers/plans/2026-09-11-...` 等と同様に手動確認と
  なる）:
  1. `draft` 枠を1つ作成し、削除ボタン押下 → confirm → 一覧から消えることを確認。
  2. `draft` 枠にOSM経由で店舗を紐づけた状態で削除 → 警告文言に件数が出ること、
     削除後にその店舗が「未割当」（`map_project_id is null`）として残ることを確認。
  3. `ready`（イラスト紐づけ済み）行に削除ボタンが表示されないことを確認。
  4. 削除対象がOSM取得/店舗登録の選択中対象だった場合、削除後に対象表示が
     クリアされることを確認。
