# Sky Tag（空中鬼ごっこ）

3次元の都市マップを飛び回りながら戦う1対1の鬼ごっこ。設計の全体像は [DESIGN.md](./DESIGN.md) を参照。

## 実装状況

| フェーズ | 内容 | 状態 |
|---|---|---|
| 1 | 飛行の土台（環境構築、飛行制御、衝突、追従カメラ、ヘッドレス実行） | ✅ 完了 |
| 2 | 対戦ルール（光線銃、HP、タッチ判定、ラウンド制、HUD） | 未着手 |
| 3 | マップ（地形の起伏、トンネル、浮遊物） | 一部（JSON読込・自動生成・3層マップは実装済み、地形の起伏は未実装） |
| 4〜7 | CPU、学習AI、オンライン対戦、強化学習 | 未着手 |

## セットアップ

```bash
npm install
npm run dev        # http://localhost:5173 でブラウザ起動
```

クリックでマウスカーソルをロックして操作開始。`Esc` で解除。

| 操作 | キー |
|---|---|
| 前後左右移動 | `W` / `A` / `S` / `D` |
| 上昇 / 下降 | `Space` / `Ctrl` |
| ブースト | `Shift` |
| 視点・照準 | マウス |

URLパラメータで挙動を変えられる：`?seed=42`（乱数シード）、`?map=generated`（シードから都市を自動生成）。

## コマンド

```bash
npm run test         # Vitest（sim / maps / physics のユニットテスト）
npm run typecheck    # tsc --noEmit
npm run build        # 本番ビルド
npm run sim:headless # 描画なしでシミュレーションを実行（Node.js）
```

ヘッドレス実行の例：

```bash
npm run sim:headless -- --map city01 --seconds 30 --seed 7
npm run sim:headless -- --generated --seed 12345
```

## 構成メモ

- `src/sim/` は **描画に一切依存しない**。Three.js も DOM も import しない。Node.js 上で単体実行でき、これがテスト・AI学習・将来のサーバー権威型オンライン対戦の土台になる。
- シミュレーションは固定60Hz。`World.step()` は同じ初期状態・同じ入力列・同じシードなら必ず同じ結果になる（`tests/world.test.ts` で検証している）。
- 乱数は `src/sim/rng.ts` のシード付きRNGのみ。`Math.random()` は使わない。
- バランスに関わる数値はすべて `src/sim/config.ts` にある。コード中に直書きしない。
- 描画側（`src/render/`）は `World` の状態を読んで補間するだけで、状態を書き換えない。
