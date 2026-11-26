# 청약딱 — 내 조건 맞춤 청약 공고 탐색

청약홈 공고를 한눈에 보고 관심 공고와 일정을 확인하는 정적 웹앱입니다. 신청과 전자서명은 청약홈에서 진행합니다.

## 현재 상태

- HTML / CSS / JavaScript, 외부 프런트엔드 라이브러리 없음.
- 기존 data/listings.json은 2026-11-25 기준으로 저장된 38건의 공고입니다. 이번 작업에서 실제 API로 재검증하지 않았습니다.
- 공식 API 자동 수집 코드와 GitHub Actions 실행·Pages 배포 설정을 추가했습니다. 인증키 등록과 GitHub 반영 전에는 예약 갱신이 동작하지 않습니다.
- 공고 일정 갱신과 신청 자격 검증은 별개입니다. 공식 공고문을 검토한 3건에 항목별 근거를 연결했습니다. 그 밖의 공고는 ‘자격 확인 필요’로 표시합니다. [검토 범위와 한계](docs/eligibility.md)를 확인하세요.

## Windows에서 실행

```powershell
python -m http.server 8000
```

http://localhost:8000 을 엽니다. index.html 직접 열기는 JSON 로딩이 제한될 수 있습니다.

## 공식 데이터 자동 갱신

[인증키 등록·실행·배포 안내](docs/data-sync.md)를 따르세요.

1. 공공데이터포털의 한국부동산원 청약홈 분양정보 조회 서비스(15098547)에 활용신청합니다.
2. GitHub 저장소 Actions Secret `APPLYHOME_SERVICE_KEY`에 인증키를 등록합니다.
3. 변경 사항을 main에 반영하고 Pages 배포 소스를 GitHub Actions로 선택합니다.
4. Actions에서 `Sync official Applyhome data`를 수동 실행해 첫 갱신을 확인합니다.

예약 시각은 한국시간 매일 09:37 / 15:37이며 GitHub 실행 상황에 따라 지연될 수 있습니다. 수집 실패 시 기존 공고를 보존하고 별도 상태 파일에 실패를 기록합니다. 화면에는 마지막 데이터 갱신 시간과 미설정·실패·30시간 이상 경과 상태가 표시됩니다.

인증키를 환경변수 `APPLYHOME_SERVICE_KEY`로 설정한 터미널에서는 다음 명령으로 직접 실행할 수 있습니다.

```powershell
python scripts/sync_applyhome.py
```

## 검증

```powershell
python -m unittest discover -s tests -v
node --test tests/ui-status.test.cjs
node --check app.js
```

테스트는 실제 키를 사용하지 않습니다. 페이지 누락·중복, 날짜 오류, 일부 목록 실패 시 기존 데이터 보존, 갱신 상태 표시와 자격 미확인 공고의 분류를 검증합니다. UI 테스트는 DOM 대역을 사용하며 시각적 레이아웃 검증을 대체하지 않습니다. 실제 공식 API 호출과 GitHub 예약 실행은 별도 통합 확인이 필요합니다.

## 파일 구성

- index.html / styles.css / app.js: 조건 입력, 필터, 관심 저장, 발표일 중복 안내, 공고 상세, 관심 공고 캘린더(.ics) 내보내기.
- sw.js: 네트워크 우선 서비스 워커. 오프라인일 때만 마지막으로 받은 공고를 보여 줍니다.
- data/listings.json: 마지막 정상 공고 데이터.
- data/sync-status.json: 자동 갱신 상태. 인증키는 포함하지 않습니다.
- scripts/sync_applyhome.py: 공식 API 5종 목록과 주택형 데이터를 수집합니다.
- tests/test_sync_applyhome.py: 수집 및 실패 보존 테스트.
- scripts/eligibility_rules.py / data/eligibility-rules.json: 검토 원본 대조 및 항목별 자격 근거.
- tests/test_eligibility_rules.py / tests/eligibility.test.cjs: 원본 변경과 만료, 미입력, 경계값, 조건별 판정 테스트.
- .github/workflows/sync-applyhome.yml: 정기 실행, 데이터 커밋, Pages 배포.
- docs/data-sync.md: 출처, 제공 범위, 이용 조건 확인, 설정 절차와 제한.

## 출시 전 남은 작업

- 실제 인증키로 데이터 연동과 배포를 검증하고 운영계정 승인·트래픽 조건을 확인합니다.
- 공고문 검토 범위를 확대합니다. 현재 3건의 일부 입력 조건을 검토했으며 전체 자격 검증이 아닙니다.
- 알림, iOS 앱 전환, 개인정보 안내, 수익화는 후속 작업입니다.
- 광고 예시 영역은 제거했습니다. 실제 광고는 자체 도메인과 트래픽 확보 후 연결합니다.
