# 구글 이미지 ZIP 다운로드 (서버 없음)

이 프로젝트는 **별도 서버 없이** 사용자의 개인 PC(브라우저)에서
구글 이미지 검색 결과를 수집하고 ZIP으로 내려받는 사용자 스크립트입니다.

## 준비물

- Chrome 또는 Edge
- Tampermonkey 확장

## 설치 방법

1) Tampermonkey 설치
- Chrome Web Store 또는 Edge Add-ons에서 “Tampermonkey” 설치

2) 사용자 스크립트 추가
- Tampermonkey 아이콘 클릭 → “새 스크립트”
- 기본 내용을 모두 삭제
- 아래 파일 내용을 그대로 붙여넣기 후 저장
  `userscript/google-images-zipper.user.js`

## 사용 방법

1) Google 이미지 검색 페이지 열기
- 예: `https://www.google.com/search?tbm=isch&q=제주도+일몰`

2) 오른쪽 상단 패널에서
- “URL 수집” → “ZIP 다운로드”

## 주의 사항

- Google 이미지 페이지 구조가 바뀌면 동작이 깨질 수 있습니다.
- 다운로드는 Tampermonkey의 요청 API를 사용해 CORS 제한을 우회합니다.
- 과도한 다운로드는 차단 또는 제한을 유발할 수 있습니다.
- 저작권과 이용 약관을 준수하세요.
