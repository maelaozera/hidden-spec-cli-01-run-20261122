# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/maelaozera/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/maelaozera/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend adalah CLI Node 22 tanpa dependensi yang menerapkan edit AI ke tree file teks dalam empat format: unified diff, SEARCH/REPLACE, V4A, dan JSON tool calls. Pencocokan konteks berjalan dalam tiga tier — persis, lalu diperlunak, lalu fuzzy — sehingga patch AI yang tidak rapi tetap bisa diterapkan dengan aman. Semua edit bersifat semua-berubah-atau-tidak-sama-sekali: bila satu hunk gagal, tidak ada file yang diubah. Skor praktik lokal: 100/100 checks.

## Run it

```sh
node main.ts [options] [PATCH]
node main.ts patch.diff
node main.ts --check patch.diff
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=02gvsh14&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
