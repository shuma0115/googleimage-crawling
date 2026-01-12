# Google Image Crawling

구글 이미지 검색 결과에서 원본 이미지를 자동 수집하고, 브라우저 다운로드 폴더의 `images/` 하위에 저장하는 Tampermonkey 사용자 스크립트입니다.

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
- 수집된 원본 이미지는 `images/` 폴더로 자동 다운로드

## 설정

- 확장자 필터: JPG/PNG/GIF/WEBP 체크박스로 선택
- 폴더명/최대 개수 등의 설정은 로컬에 저장됨

## 주의 사항

- Google 이미지 페이지 구조가 바뀌면 동작이 깨질 수 있습니다.
- 다운로드는 브라우저 기본 다운로드 폴더 하위의 `images/` 폴더에 저장됩니다.
- 브라우저 설정에서 “다운로드 전에 위치 묻기”가 켜져 있으면 매번 확인창이 뜰 수 있습니다.
- 과도한 자동 수집은 Google 측에서 차단될 수 있습니다.
- 저작권과 이용 약관을 준수하세요.
