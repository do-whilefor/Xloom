<h1 align="center">Xloom</h1>

<p align="center"><strong>Xloom</strong>은 로컬 터미널에서 실행되는 AI 보안 연구 도우미입니다.</p>
<p align="center">일반 채팅 · 두 에이전트의 협업 · 증거 보관</p>

[简体中文](README.md) | [English](README.en.md) | **한국어**

메시지를 입력하면 바로 대화할 수 있고, `/run <목표>`를 사용하면 별도의 연구 작업을 시작할 수 있습니다. **Decide**는 계획과 검토를 담당하고, **Execute**는 파일, PowerShell, Chrome 도구를 사용해 조사합니다. 두 에이전트는 공유 블랙보드에 사실, 진행 상황, 증거를 저장합니다.

---

## 빠른 시작

### Xloom 설치 및 실행

**Windows, Git, Node.js 24 이상, PowerShell 7**이 필요합니다. `pwsh.exe`가 PATH에 등록되어 있어야 합니다. Windows Terminal 사용을 권장합니다.

PowerShell에서 소스로 설치합니다.

```powershell
git clone https://github.com/do-whilefor/Xloom.git
Set-Location Xloom
npm ci --ignore-scripts
npm run build
npm link --ignore-scripts
```

설치 후 작업 디렉터리에서 실행합니다.

```powershell
xloom
```

<details>
<summary>소스에서 직접 실행 및 빌드 검사</summary>

저장소 디렉터리에서 직접 실행할 수도 있습니다.

```powershell
npm start
```

소스를 수정한 후 다시 빌드하면 연결된 `xloom` 명령에 변경 사항이 반영됩니다.

```powershell
npm run build
```

타입 검사와 빌드를 실행합니다.

```powershell
npm run check
```

</details>

### 연구 시작

대화형 인터페이스에 목표, 허가된 범위, 완료 조건을 입력합니다.

```text
/run 허가된 프로젝트의 서버 측 접근 권한 경계를 점검하고, 원본 증거를 보존하며, 결과 보고서를 작성하세요. 완료되면 중지하세요.
```

작업 완료 제안은 별도의 검토를 거칩니다. 실행 중에는 `/hint <내용>`으로 정보를 추가하고, `/pause`로 일시 중지하거나, `/stop`으로 중지할 수 있습니다. 이미 저장된 증거와 진행 상황은 유지됩니다.

실행할 때마다 새 채팅이 시작됩니다. 이전 연구 작업을 이어서 진행하려면 `/tasks`로 작업 목록을 확인하고, `/open <작업ID>`로 선택한 다음 `/start`를 입력합니다. 전체 명령과 단축키는 `/help`에서 확인할 수 있습니다.

터미널에서 `xloom status`를 실행하면 저장된 작업 상태를 확인할 수 있고, `xloom report`를 실행하면 Markdown 보고서가 출력됩니다.

## 자료

- [**전역 설정 예시**](settings.example.json)
- [**도구 실행 및 HTTP 요청**](resources/runtime/execution.md)
- [**PDF 문서**](refer/papers/arxiv.pdf)

Xloom은 허가된 보안 연구에만 사용해야 합니다. 도구는 현재 사용자의 시스템 권한으로 실행됩니다. 연구 결과는 원본 증거와 대조하여 검증해야 합니다.

이 프로젝트는 [GNU Affero General Public License v3.0(AGPL-3.0)](LICENSE)에 따라 배포됩니다.
