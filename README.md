# 📵 Detached Gen

아이폰에서 실리테번 홈화면 웹앱을 쓸 때, **화면을 벗어나면 생성이 에러로 죽는 문제**를 없앱니다.

## 왜 죽었나

범인은 iOS가 아니라 ST 서버 코드입니다. `src/endpoints/backends/chat-completions.js`:

```js
const controller = new AbortController();
request.socket.removeAllListeners('close');
request.socket.on('close', () => controller.abort());   // ← 이것
```

ST는 **클라이언트 소켓이 끊기면 상위 API 호출을 즉시 취소**합니다. 그런데 아이폰은
백그라운드 진입 후 몇 초 안에 웹앱을 정지시키고, 그러면 소켓이 끊깁니다. 결과적으로:

1. 폰이 요청을 보내고 **응답이 올 때까지 소켓을 붙들고** 기다림 (`stream_openai=false`라 통짜 대기)
2. 홈 버튼 → iOS가 앱 정지 → 소켓 끊김
3. ST 서버: "클라이언트 끊겼네" → `controller.abort()` → **생성 폐기**
4. 돌아오면 에러

즉 **앱이 살아있어야 했던 유일한 이유가 소켓을 붙들기 위해서**였습니다.

## 어떻게 고쳤나

앱을 살리는 대신, **붙들 소켓 자체를 없앴습니다.**

```
[기존]  폰 ──────────── 긴 소켓 (30초~) ──────────── ST ── 모델
                       ↑ 끊기면 생성 폐기

[지금]  폰 ─ 0.2초 ─ 플러그인   "접수번호 3847"
                      └──────── 긴 소켓 ──────── ST ── 모델
                         (소켓 주인이 플러그인이라 안 끊김)
        폰 ─ 0.2초 ─ "3847 다 됐어?" ─ 플러그인
```

- 폰은 **0.2초짜리 요청만** 보냅니다. 그 사이에 백그라운드 갈 일이 없습니다.
- 상위 호출을 붙드는 건 플러그인이고, 그 소켓은 폰과 무관하므로 abort 규칙이 발동하지 않습니다.
- 폰이 정지되면 폴링이 잠깐 멈출 뿐, 돌아오면 이어서 물어봅니다.

**서비스워커·웹푸시·HTTPS·무음 오디오 전부 불필요합니다.** 살려둘 게 없어졌으니까요.

## iOS가 앱에 하는 두 가지와 대응

| | 언제 | 결과 | 대응 |
|---|---|---|---|
| **정지(suspend)** | 백그라운드 후 몇 초, 거의 항상 | 얼어붙음, 기억은 유지 | 폴링이 멈췄다 재개 |
| **종료(kill)** | 램 부족 시. **시간 기준 없음** | 페이지가 새로 로드됨, 기억 소실 | jobId를 localStorage에 → 리로드 후 자동 회수 |

종료는 jetsam(커널 메모리 감시자)이 **램을 많이 먹는 백그라운드 앱부터** 골라 죽입니다.
ST는 확장이 많아 무거운 편이라 종료가 드물지 않습니다. 그래서 회수 경로가 필수입니다.

## 설치

서버 플러그인 하나 + 클라이언트 확장 하나로 이루어집니다. 둘 다 있어야 동작합니다.

`config.yaml`에 `enableServerPlugins: true`가 필요합니다.

```bash
# SillyTavern 루트에서
cd /path/to/SillyTavern

# 1) 서버 플러그인
git clone https://github.com/jinny1010/detached-gen.git /tmp/detached-gen
mkdir -p plugins/detached-gen
cp /tmp/detached-gen/index.js plugins/detached-gen/

# 2) 클라이언트 확장
mkdir -p public/scripts/extensions/third-party/detached-gen
cp /tmp/detached-gen/st-ext/* public/scripts/extensions/third-party/detached-gen/

# 3) 재시작 (pm2를 쓰면 프로세스명에 맞게)
pm2 restart <ST_PROCESS>    # 또는 서버를 직접 재시작
```

재시작 로그에 `[detached-gen] plugin loaded (v1.0.0)` 이 뜨면 서버 쪽 준비 완료입니다.

그다음 ST를 브라우저에서 **하드 리프레시**(캐시된 JS/CSS 갱신) 하고, **확장 설정 →
📵 백그라운드 생성 → "연결 테스트"** 를 누릅니다. ✅ 가 뜨면 끝입니다.

### 배포 파일 위치 요약

| 파일 | 위치 |
|---|---|
| `index.js` | `SillyTavern/plugins/detached-gen/` |
| `st-ext/*` (index.js, manifest.json, style.css) | `SillyTavern/public/scripts/extensions/third-party/detached-gen/` |

### API (`/api/plugins/detached-gen`)

| 라우트 | 하는 일 |
|---|---|
| `POST /start` | jobId 발급 후 **즉시 응답**. 생성은 서버가 이어서 수행 |
| `GET /poll?jobId=` | `running` / `done` / `error` / `cancelled` / `unknown` |
| `POST /cancel` | 정지 버튼용. 내부 호출 abort |
| `POST /selftest` | 세션·CSRF 전달이 되는지 **생성 없이** 확인 |
| `GET /status` | 버전, 진행 중 건수 |

라우트는 ST의 전역 body parser·세션·CSRF·로그인 미들웨어 뒤에 붙습니다(`src/server-main.js`).
따라서 raw curl은 **403이 정상**입니다. 브라우저에서만 호출됩니다.

## 설정

ST 확장 설정 → **📵 백그라운드 생성**. 켜고 끄는 값은 **기기별**(localStorage)입니다 —
폰에서만 켜고 데스크탑은 꺼두는 게 자연스럽습니다.

## 안전장치

- **스트리밍이면 가로채지 않음.** SSE 위조는 범위 밖이라 원래 경로로 흘려보냅니다.
- **`/start` 실패 시 원래 방식으로 폴백.** 아직 아무것도 시작 안 된 시점이라 안전합니다.
- **세션 전달 실패(401/403) 시 원래 방식으로 재시도.** ST 문턱에서 막힌 것이므로 모델까지 간 적이
  없고, 따라서 재시도해도 이중 과금이 없습니다. 기능이 깨져도 **에러가 아니라 기존 동작으로 degrade**합니다.
- **부수 생성은 회수 대상에서 제외.** ST는 요약·임퍼소네이트·스와이프도 같은 엔드포인트로 보냅니다.
  전부 detach 되지만(그래야 abort가 안 남), **리로드 후 자동 삽입은 일반 답장(`normal`)만** 합니다.
  `GENERATION_STARTED` 이벤트로 종류를 구분합니다. 안 그러면 요약문이 답장 자리에 박힙니다.
- **중복·오삽입 방지.** 회수 시 `chatId`·`chat.length`가 시작 때와 같고 마지막 메시지가 유저 것일 때만
  삽입합니다.
- job 결과는 완료 시 디스크에 저장되어 서버 재시작에도 1시간 남습니다.

## 한계

- **스트리밍 미지원.** `stream_openai=true`로 켜면 이 확장은 그냥 비켜섭니다(에러는 안 남).
- **스와이프·이어쓰기는 kill 회수 안 됨.** 정지(suspend)는 모든 생성 종류가 보호됩니다 — 폴링이
  재개되면 ST의 원래 흐름이 그대로 이어지니까요. 페이지가 **종료**된 경우의 자동 삽입만
  일반 답장으로 제한됩니다(스와이프 결과를 새 메시지로 넣으면 안 되므로).
- 회수 경로는 ST의 정상 생성 파이프라인을 타지 않으므로, `saveReply`가 처리하지 않는
  후처리 확장은 걸리지 않을 수 있습니다.

## 트러블슈팅

답장이 안 오면 **먼저 "연결 테스트"** 를 누르세요. 생성을 태우지 않고 세션 전달 여부만 판정합니다.
