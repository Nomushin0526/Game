# Sky Tag（空中鬼ごっこ）

3次元の都市マップを飛び回りながら戦う1対1の鬼ごっこ。設計の全体像は [DESIGN.md](./DESIGN.md) を参照。

## 実装状況

| フェーズ | 内容 | 状態 |
|---|---|---|
| 1 | 飛行の土台（環境構築、飛行制御、衝突、追従カメラ、ヘッドレス実行） | ✅ 完了 |
| 2 | 対戦ルール（光線銃、HP、タッチ判定、オーバーヒート、制限時間、ラウンド制、HUD、画面分割） | ✅ 完了 |
| 3 | マップ（JSON読込、地形の起伏、トンネル、高架橋、木々、クレーン、浮遊物、自動生成） | ✅ 完了 |
| 4 | CPU（段階A） | 未着手 |
| 5〜7 | 学習AI、オンライン対戦、強化学習 | 未着手 |

## セットアップ

```bash
npm install
npm run dev        # http://localhost:5173 でブラウザ起動
```

タイトル画面でモードを選択 →「1人で飛ぶ（練習）」または「ローカル2人対戦」。
試合中はクリックでマウスカーソルをロック、`Esc` で解除。

| 操作 | キーボード＋マウス | ゲームパッド |
|---|---|---|
| 前後左右移動 | `W` / `A` / `S` / `D` | 左スティック |
| 上昇 / 下降 | `Space` / `Ctrl` | RB / LB |
| 視点・照準 | マウス | 右スティック |
| 射撃 | 左クリック | RT |
| ブースト | `Shift` | LT |

ローカル2人対戦は上下2分割。ゲームパッド側にだけ弱いエイムアシストが入る（`config.input.aimAssistEnabled` でOFFにできる）。

URLパラメータ：`?seed=42`（乱数シード）、`?map=generated`（シードから都市を自動生成）。

## ルールとバランス

- **鬼（ハンター）**：逃亡者のHPを0にするか、タッチすれば勝ち。移動速度・ブースト速度・光線銃のダメージ・射程・連射速度すべてで逃亡者を上回る。
- **逃亡者（ランナー）**：鬼のHPを0にするか、**制限時間（180秒）まで生き残れば勝ち**。火力と最高速では劣るが、ブーストゲージの消費が少なく回復が速いので、遮蔽物を使って視線を切り続けられる。
- 2ラウンド先取（Best of 3）。ラウンドごとに鬼と逃亡者が入れ替わるため、スコアは陣営ではなくプレイヤー枠ごとに記録される。
- 時間切れの扱いは `config.rules.timeoutWinner`（`"runner"` / `"draw"`）で切り替え。
- 数値はすべて `src/sim/config.ts` にある。この非対称バランスはまだ実戦検証していないので、フェーズ4の `simBatch` で鬼の勝率が45〜55%に入るか確認して調整するのが前提。主な調整つまみは `rules.timeLimit` と両陣営の `boostDrain` / `boostRegen`。

## マップ

マップは `maps/*.json`。`src/maps/loader.ts` が読み込み時に検証し、地形定義を高さフィールドに、トンネル定義をただの箱に展開する。物理と描画はどちらも同じ `Terrain` インスタンスを見るので、見た目と当たり判定が食い違うことはない。

```jsonc
{
  "id": "city01",
  "size": { "x": 400, "z": 400 },
  "ceiling": 150,
  "floor": 0,
  // 地形の起伏。seed から生成するか、heights に 0..1 を (resolution+1)^2 個直接書く
  "terrain": { "resolution": 32, "maxHeight": 20, "seed": 4021, "featureSize": 9, "octaves": 4 },
  // 覆われた通路。読み込み時に壁2枚＋屋根の箱に展開される
  "tunnels": [{ "pos": { "x": 0, "y": 8, "z": 0 }, "length": 150, "width": 18, "height": 13 }],
  "spawns": [{ "x": -170, "y": 55, "z": -170 }],
  "solids": [
    { "shape": "box", "pos": {...}, "size": {...}, "rotY": 0, "tag": "building" },
    { "shape": "cylinder", "pos": {...}, "radius": 3, "height": 5, "tag": "tree" }
  ]
}
```

`tag` は色分けと（フェーズ4以降の）AIの遮蔽物判定に使う：`building` / `bridge` / `tunnel` / `tree` / `crane` / `floater` / `prop` / `terrain` / `ground`。

`city01` の配置は `tools/buildCity01.ts` が生成している。建物のY座標を地形の高さから計算しているので、斜面に浮いたり埋まったりしない。地形パラメータを変えたら再生成する：

```bash
npx tsx tools/buildCity01.ts > maps/city01.json
```

シードからの自動生成は `generateCityMap(seed)`。地形・低層ビル・木々・トンネル・高架橋・高層ビル・渡り廊下・クレーン・浮遊物を3層すべてに配置する。ブラウザでは `?map=generated&seed=123` で遊べる。

## コマンド

```bash
npm run test         # Vitest（109 テスト）
npm run typecheck    # tsc --noEmit
npm run build        # 本番ビルド
npm run sim:headless # 描画なしでシミュレーションを実行（Node.js）
```

ヘッドレス実行の例：

```bash
npm run sim:headless -- --map city01 --seconds 30 --seed 7
npm run sim:headless -- --match --seed 3        # ラウンド制の試合を最後まで回す
npm run sim:headless -- --generated --seed 12345
```

## 構成メモ

- `src/sim/` は **描画に一切依存しない**。Three.js も DOM も import しない。Node.js 上で単体実行でき、これがテスト・AI学習・将来のサーバー権威型オンライン対戦の土台になる。
- シミュレーションは固定60Hz。`World.step()` は同じ初期状態・同じ入力列・同じシードなら必ず同じ結果になる（`tests/world.test.ts` で検証している）。
- 乱数は `src/sim/rng.ts` のシード付きRNGのみ。`Math.random()` は使わない。
- `src/sim/rules.ts` は `World` に依存しない純粋な関数群なので、手で組み立てた状態だけでラウンドの勝敗をテストできる。
- HPの増減はすべて `src/sim/damage.ts` を通る（無敵時間・撃墜処理・イベント発行が一箇所にまとまる）。
- 人間・ゲームパッド・（将来の）AIはすべて同じ `PlayerInput` を `world.step()` に渡す。エイムアシストは入力側で完結していて、シミュレーションからは見えない。
- 描画側（`src/render/`）は `World` の状態を読んで補間するだけで、状態を書き換えない。

## DESIGN.md 未決事項の現状

| 項目 | 現在の実装 | 設定 |
|---|---|---|
| 時間切れの扱い | 逃亡者の勝ち | `rules.timeoutWinner` |
| 相手の位置がどこまで見えるか | 視線が通っているときだけ方向矢印を表示 | `hud.enemyIndicator`（`lineOfSight` / `always` / `never`） |
| 被弾後の無敵時間 | なし（0秒） | `rules.hitInvulnerability` |
| 見た目の方向性 | ローポリの箱・円柱＋色分け（仮） | — |
| 簡易レーダー | 未実装（方向矢印のみ） | — |
