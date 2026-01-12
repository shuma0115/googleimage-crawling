# Google Image Crawling

구글 이미지 검색 결과에서 원본 이미지를 자동 수집하고 지정한 하위 경로로 저장하는 Tampermonkey 사용자 스크립트입니다. 뷰어 원본 위주로 수집하며 썸네일 다운로드를 피하도록 설계되어 있습니다.

## 주요 기능

- 원본 자동 수집: 썸네일을 순차 클릭해 뷰어의 원본 URL을 수집하고 다운로드
- 뷰어 전용 수집: 일반 썸네일 URL 수집을 제외하고 뷰어 원본만 수집
- 확장자 필터: JPG/PNG/GIF/WEBP/SVG 선택
- 파일명 접두어 + 번호 저장: `prefix-0001.jpg` 형태
- 원본 자동 수집만 사용: 썸네일 URL 수집을 끄고 원본만 수집
- 실패 URL 로그 출력: 콘솔에 실패 원인 출력
- 패널 최소화: 접힘 상태에서 갤러리 아이콘 버튼 표시

## 준비물

- Chrome 또는 Edge
- Tampermonkey 확장

## 설치

1) Tampermonkey 설치
- Chrome Web Store 또는 Edge Add-ons에서 “Tampermonkey” 설치

2) 사용자 스크립트 추가
- Tampermonkey 아이콘 클릭 → “새 스크립트”
- 기본 내용을 모두 삭제
- 아래 파일 내용을 그대로 붙여넣고 저장
  - `userscript/googl-eimage-crawling.js`

## 사용 방법

1) Google 이미지 검색 페이지 열기
- 예: `https://www.google.com/search?udm=2&q=제주도+일몰`

2) 오른쪽 상단 패널에서 “원본 자동 수집” 클릭
- 썸네일을 순차 클릭하며 원본 URL을 수집
- 수집된 원본 이미지는 설정한 경로로 자동 다운로드

## 설정

- 저장 폴더: 예) `images` 또는 `images/2025/01`
- 파일명 접두어: 예) `karina` → `karina-0001.jpg`
- 확장자 필터: JPG/PNG/GIF/WEBP/SVG 체크박스로 선택
- 원본 자동 수집만 사용: 일반 URL 수집을 끄고 원본만 수집
- 실패 URL 로그 출력: 콘솔에서 실패 원인 확인
 - 썸네일 차단: `tbn0.gstatic.com` 썸네일 도메인은 자동 필터링

## 하위경로 폴더 저장을 위한 Tampermonkey 다운로드 모드 설정

Tampermonkey 기본 다운로드 모드에서는 하위 경로 저장이 막힐 수 있습니다. 아래처럼 설정하면 `images/2025/01` 같은 하위 경로 저장이 가능합니다.

1) Tampermonkey 대시보드 열기
2) 설정(Settings) 탭으로 이동
3) “다운로드 모드(Download Mode)”를 `Browser API` 또는 `Browser API (recommended)`로 변경
4) 브라우저에서 “다운로드 전에 위치 묻기” 설정이 켜져 있으면 필요에 따라 꺼주세요

### 다운로드 모드가 보이지 않는 경우

- Tampermonkey 버전을 최신으로 업데이트
- 설정 모드를 상급자(Advanced)로 변경한 뒤 다시 확인
- `설정 > 기타 > 다운로드 모드` 항목이 없는 경우 브라우저(Chrome/Edge) 재시작 후 다시 확인

## 주의 사항

- Google 이미지 페이지 구조가 바뀌면 동작이 깨질 수 있습니다.
- 다운로드는 브라우저 기본 다운로드 폴더 하위의 지정 경로에 저장됩니다.
- 브라우저 설정에서 “다운로드 전에 위치 묻기”가 켜져 있으면 매번 확인창이 뜰 수 있습니다.
- 과도한 자동 수집은 Google 측에서 차단될 수 있습니다.
- 저작권과 이용 약관을 준수하세요.
