/* 프런트(별도 서버, 예: :8887)가 호출할 백엔드(FastAPI) 주소.
 * 기본: 프런트를 연 호스트의 8886 포트를 백엔드로 사용.
 * 원격 백엔드를 쓰려면 이 값을 직접 고치거나(예: 'http://192.168.0.10:8886'),
 * 실행 중 사이드바 '백엔드 설정'에서 바꾸면 된다(localStorage 우선). */
window.NIT_BACKEND = location.protocol + '//' + location.hostname + ':8886';
