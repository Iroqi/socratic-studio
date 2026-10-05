# HTTP 层端到端冒烟测试：真的起一个服务，走 SSE，验证提问卡阻塞与作答回传。
#
# 用 faux provider（无需任何 API key），所以这条链路在没有订阅的机器上也能验证。
# 用法：pwsh -File test/http-smoke.ps1

param(
  [int]$Port = 8799
)

$ErrorActionPreference = 'Stop'
$app = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$dataDir = Join-Path $env:TEMP ("socratic-http-" + [guid]::NewGuid().ToString('N').Substring(0, 8))

$passed = 0; $failed = 0
function Check($name, $cond, $detail) {
  if ($cond) { $script:passed++; Write-Host "  OK   $name" -ForegroundColor Green }
  else { $script:failed++; Write-Host "  FAIL $name" -ForegroundColor Red; if ($detail) { Write-Host "       $detail" -ForegroundColor DarkGray } }
}

# ── 编排 faux 回复脚本 ─────────────────────────────────────────────
$graphConcepts = @(
  @{ id = 'variable-scope'; name = '作用域'; summary = '变量可被访问的代码区域'; depends_on = @(); misconceptions = @('混淆词法作用域与动态作用域') },
  @{ id = 'closures'; name = '闭包'; summary = '函数连同其词法环境的引用'; depends_on = @('variable-scope'); misconceptions = @('闭包复制变量') }
)
$script = @(
  @(
    @{ type = 'text'; text = "我先把这块拆成两个概念。`n`n1. 作用域`n2. 闭包" },
    @{ type = 'toolCall'; name = 'update_learning_graph'; arguments = @{ topic = 'JavaScript 闭包'; goal = '在项目里用对闭包'; pedagogy = 'programming'; concepts = $graphConcepts } },
    # GATE-1 的正确形状：确认走题卡。以前桩里写的是正文一句「⛔ 等待你的确认」，
    # 而活数据证明那条路会让学习者连打三次「可以」——桩必须照修好的样子写。
    @{ type = 'toolCall'; name = 'ask_user_question'; arguments = @{
        id = 'gate1:confirm'; concept_id = 'none'; header = '确认范围'
        question = '这个范围和顺序可以吗？'
        options = @(@{ label = '就按这个顺序' }, @{ label = '先只看闭包' })
    } }
  ),
  @(
    @{ type = 'text'; text = '先别查——你猜外层函数已经 return 之后，里层还能不能读到外层当时的变量？' },
    @{ type = 'toolCall'; name = 'ask_user_question'; arguments = @{
        id = 'closures:q_outer_var'; concept_id = 'closures'; header = '探针'
        question = '外层函数已经 return 了，里层函数还能读到外层当时的变量吗？'
        options = @(@{ label = '能读到' }, @{ label = '读不到' })
    } }
  ),
  @(
    @{ type = 'text'; text = '对，它握着的是那个绑定本身。' },
    @{ type = 'toolCall'; name = 'set_progress_state'; arguments = @{
        updates = @(@{ concept_id = 'closures'; state = 'seen'; next_action = '最小讲解→PREDICT'; evidence = '答出「能读到」且理由正确' })
        events = @(@{ concept_id = 'closures'; kind = 'observed'; summary = '冷启动探针答对' })
    } }
  ),
  @( @{ type = 'text'; text = '那换一个问法再确认一下。' } )
)
# faux 脚本以 JSON 文本直接 POST（/api/__faux 收 body.script，不再读服务端文件）
$scriptJson = $script | ConvertTo-Json -Depth 20

# ── 起服务 ────────────────────────────────────────────────────────
$env:SOCRATIC_PORT = "$Port"
$env:SOCRATIC_DATA_DIR = $dataDir
$env:SOCRATIC_ENABLE_FAUX = '1'
# 心跳调密一点，好让"学习者答题的那 0.9 秒"里至少落进两个 ping——
# 这一局要验的正是：答题期间流不能静默，否则前端 150 秒看门狗会把题卡判死。
$env:SOCRATIC_SSE_HEARTBEAT_MS = '300'
$outLog = Join-Path $env:TEMP "socratic-http-out.log"
$errLog = Join-Path $env:TEMP "socratic-http-err.log"
$proc = Start-Process -FilePath 'node' -ArgumentList 'server/serve.mjs' -WorkingDirectory $app `
  -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 4

$base = "http://127.0.0.1:$Port"
$H = @{ 'Content-Type' = 'application/json' }

try {
  Write-Host "`n1. 服务与静态资源"
  $boot = Invoke-RestMethod "$base/api/bootstrap" -TimeoutSec 20
  Check '服务启动' ($boot.app -eq 'Socratic Studio') ($boot | ConvertTo-Json -Compress)
  Check 'faux provider 已注册' (($boot.availableModels | Where-Object { $_.provider -eq 'faux' }).Count -eq 1)
  $idx = Invoke-WebRequest "$base/" -UseBasicParsing -TimeoutSec 10
  Check 'index.html 可访问' ($idx.StatusCode -eq 200)
  $js = Invoke-WebRequest "$base/app.js" -UseBasicParsing -TimeoutSec 10
  Check 'app.js 可访问' ($js.StatusCode -eq 200)

  Write-Host "`n2. 建学习 + 装载脚本"
  $nb = Invoke-RestMethod "$base/api/notebooks" -Method POST -Headers $H -Body (@{ topic = 'JavaScript 闭包'; goal = '在项目里用对闭包' } | ConvertTo-Json)
  $id = $nb.notebook.id
  Check '学习已创建' ([bool]$id) $id
  $loaded = Invoke-RestMethod "$base/api/__faux" -Method POST -Headers $H -Body (@{ script = $scriptJson } | ConvertTo-Json)
  Check '脚本回复已装载' ($loaded.queued -eq 4) ($loaded | ConvertTo-Json -Compress)

  Write-Host "`n3. 设置当前模型"
  $models = (Invoke-RestMethod "$base/api/providers").availableModels
  Check '模型出现在可用清单' (($models | Where-Object { $_.provider -eq 'faux' }).Count -ge 1)
  $fauxModelId = ($models | Where-Object { $_.provider -eq 'faux' } | Select-Object -First 1).model
  Invoke-RestMethod "$base/api/settings" -Method PUT -Headers $H -Body (@{ activeModel = @{ provider = 'faux'; model = $fauxModelId } } | ConvertTo-Json) | Out-Null
  Write-Host "       当前模型：faux / $fauxModelId" -ForegroundColor DarkGray

  Write-Host "`n4. 教学回合（SSE）"
  # 用 .NET HttpClient 读流：需要在提问事件到达后作答，所以不能等整个响应读完
  Add-Type -AssemblyName System.Net.Http
  $client = [System.Net.Http.HttpClient]::new()
  $client.Timeout = [TimeSpan]::FromSeconds(90)
  $payload = @{ message = '教我闭包'; model = @{ provider = 'faux'; model = $fauxModelId } } | ConvertTo-Json
  $content = [System.Net.Http.StringContent]::new($payload, [Text.Encoding]::UTF8, 'application/json')
  $req = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, "$base/api/notebooks/$id/turn")
  $req.Content = $content
  $resp = $client.SendAsync($req, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).Result
  Check 'SSE 响应开始' ($resp.StatusCode -eq 200) "status=$($resp.StatusCode)"

  $stream = $resp.Content.ReadAsStreamAsync().Result
  $reader = [System.IO.StreamReader]::new($stream, [Text.Encoding]::UTF8)
  $events = New-Object System.Collections.ArrayList
  $answered = 0
  $pings = 0
  $deadline = (Get-Date).AddSeconds(60)
  $buffer = ''
  while (-not $reader.EndOfStream -and (Get-Date) -lt $deadline) {
    $line = $reader.ReadLine()
    if ($null -eq $line) { break }
    if ($line.StartsWith(':')) { $pings++; continue }   # 心跳注释行：不是事件，但是"流活着"的证据
    if (-not $line.StartsWith('data:')) { continue }
    $json = $line.Substring(5).Trim()
    if (-not $json) { continue }
    try { $evt = $json | ConvertFrom-Json } catch { continue }
    [void]$events.Add($evt)

    if ($evt.type -eq 'ask') {
      $answered++
      Write-Host "       → 收到提问 #$($answered)：$($evt.question)（$($evt.options.Count) 个选项）" -ForegroundColor DarkGray
      # 学习者"想一会儿"再答：这一段服务端只有心跳，没有任何教学事件
      if ($answered -eq 1) { Start-Sleep -Milliseconds 900 }
      # 切走再切回来时前端做的那件事：另开一条 GET /stream，把这条回合从头重放再接实时。
      # 必须赶在作答之前看——回合正卡在这道题上等，缓冲里就该有它。
      # 读它要用带期限的异步读：缓冲重放完之后这条流只剩心跳，同步 ReadLine 会挂住整个套件。
      if ($answered -eq 1) {
        $replayClient = [System.Net.Http.HttpClient]::new()
        $replayTypes = New-Object System.Collections.ArrayList
        $replayStatus = 0
        $acc = ''
        try {
          $rr = $replayClient.GetAsync("$base/api/notebooks/$id/stream", [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).Result
          $replayStatus = [int]$rr.StatusCode
          $rs = $rr.Content.ReadAsStreamAsync().Result
          $bytes = New-Object byte[] 65536
          $quiet = 0
          # 心跳在这套里是 300ms 一跳，"读不到字节"永远不成立，所以轮数必须封顶
          for ($round = 0; $round -lt 12 -and $quiet -lt 2; $round++) {
            $t = $rs.ReadAsync($bytes, 0, $bytes.Length)
            if (-not $t.Wait(1200)) { $quiet++; continue }   # 1.2 秒没字节 = 这条流只剩心跳了
            if ($t.Result -le 0) { break }
            $quiet = 0
            $acc += [Text.Encoding]::UTF8.GetString($bytes, 0, $t.Result)
          }
        } catch { $replayStatus = -1 }
        foreach ($line in ($acc -split "`n")) {
          if (-not $line.StartsWith('data:')) { continue }   # 心跳注释行不是事件
          $rj = $line.Substring(5).Trim()
          if (-not $rj) { continue }
          try { [void]$replayTypes.Add(($rj | ConvertFrom-Json).type) } catch { continue }
        }
        Check '重连 /stream 开得上（切回来不用干等盘，也不是 404）' ($replayStatus -eq 200) "status=$replayStatus"
        Check '重连从头部重放这条回合：图、正文、题都在' (($replayTypes -contains 'ask') -and ($replayTypes -contains 'graph')) (($replayTypes | Select-Object -Unique) -join ',')
        try { $replayClient.Dispose() } catch { }
      }
      # 每一道题都答第一个选项；探针那题额外补一句推理（判 Seen 证据时要用到它）
      $ansPayload = @{
        questionId = $evt.questionId
        selected = @($evt.options[0].label)
        text = $(if ($evt.questionId -eq 'closures:q_outer_var') { '函数记住了它出生时的环境' } else { '' })
      } | ConvertTo-Json
      $ac = [System.Net.Http.StringContent]::new($ansPayload, [Text.Encoding]::UTF8, 'application/json')
      $ar = $client.PostAsync("$base/api/notebooks/$id/answer", $ac).Result
      Check '作答被接受' ($ar.StatusCode -eq 200) "status=$($ar.StatusCode)"
    }
    if ($evt.type -eq 'closed') { break }
    if ($evt.type -eq 'error') {
      Write-Host "       ! error($($evt.reason)): $($evt.message)" -ForegroundColor Yellow
    }
  }
  $reader.Dispose()

  $types = $events | ForEach-Object { $_.type }
  Check '收到 graph 事件' ($types -contains 'graph')
  Check '收到 ask 事件' ($types -contains 'ask')
  Check '收到 answer 事件（作答已回传）' ($types -contains 'answer')
  Check '收到 progress 事件' ($types -contains 'progress')
  Check '收到 done 事件' ($types -contains 'done')
  # 第一题故意"想"了 0.9 秒才答：那一段服务端只能靠心跳证明流还活着
  Check '答题期间流上有心跳（慢慢想不该被判成端点卡住）' ($pings -ge 2) "ping=$pings"
  Check '没有 fatal error' (-not (($events | Where-Object { $_.type -eq 'error' -and $_.fatal }).Count))
  $prose = ($events | Where-Object { $_.type -eq 'text_delta' } | ForEach-Object { $_.delta }) -join ''
  Check '流式正文非空' ($prose.Length -gt 10) $prose

  # GATE-1 的形状：确认由题卡收，而且发生在存图**之后**。
  # 活数据里它是正文里的一句「⛔ 等待你的确认」——不阻塞回合，学习者只能自己打字，
  # 下一轮记录里又什么都不留，于是同一份概念清单被念了三遍。
  $graphAt = -1; $gateAt = -1
  for ($i = 0; $i -lt $events.Count; $i++) {
    $e = $events[$i]
    if ($graphAt -lt 0 -and $e.type -eq 'graph') { $graphAt = $i }
    if ($gateAt -lt 0 -and $e.type -eq 'ask' -and $e.questionId -eq 'gate1:confirm') { $gateAt = $i }
  }
  Check 'GATE-1 走 ask_user_question，且排在存图之后' ($graphAt -ge 0 -and $gateAt -gt $graphAt) "graph=$graphAt gate=$gateAt"
  Check '门禁那题不算探针：concept_id 是 none，不会把 Seen 记到概念头上' `
    (@($events | Where-Object { $_.type -eq 'tool_exec' -and $_.name -eq 'ask_user_question' } |
      Where-Object { $_.args.id -eq 'gate1:confirm' })[0].args.concept_id -eq 'none')
  Check '正文里不再出现降级版的确认标记' (-not $prose.Contains('等待你的确认')) $prose

  # §1.2 的 Unknown→Seen 是无条件的，所以由应用在收到作答时代写。
  # 钉的是"谁写的"：这条 progress 必须出现在**它所属那道题**的 ask_user_question 收尾之前——
  # 老师那次 set_progress_state 在下一步才发生，它产生的同名事件一律不算。
  # 现在一局里有两道题（GATE-1 的确认 + 探针），所以按题定位，不取全局第一次。
  $probeAskAt = -1
  for ($i = 0; $i -lt $events.Count; $i++) {
    if ($events[$i].type -eq 'ask' -and $events[$i].questionId -eq 'closures:q_outer_var') { $probeAskAt = $i; break }
  }
  $autoIdx = -1; $askEndIdx = -1
  for ($i = $probeAskAt; $i -lt $events.Count; $i++) {
    $e = $events[$i]
    if ($autoIdx -lt 0 -and $e.type -eq 'progress' -and (($e.changes | ForEach-Object { "$($_.from)->$($_.to)" }) -contains 'unknown->seen')) { $autoIdx = $i }
    if ($askEndIdx -lt 0 -and $e.type -eq 'tool_end' -and $e.name -eq 'ask_user_question') { $askEndIdx = $i }
  }
  Check '探针一答，应用当场把那格写成 Seen' ($probeAskAt -ge 0 -and $autoIdx -gt $probeAskAt -and $askEndIdx -gt $probeAskAt -and $autoIdx -lt $askEndIdx) "probe=$probeAskAt auto=$autoIdx askEnd=$askEndIdx"
  $autoWrites = @($events | Where-Object { $_.type -eq 'progress' -and (($_.changes | ForEach-Object { "$($_.from)->$($_.to)" }) -contains 'unknown->seen') })
  Check '同一格不会被重复写 Seen（老师那一步成了 no-op）' ($autoWrites.Count -eq 1) "$($autoWrites.Count) 次"

  Write-Host "`n5. 落盘与恢复"
  $detail = (Invoke-RestMethod "$base/api/notebooks/$id").notebook
  Check 'Graph 已落盘（2 个概念）' ($detail.graph.concepts.Count -eq 2) ($detail.graph.concepts | ConvertTo-Json -Compress)
  Check '依赖关系保留' ($detail.graph.concepts[1].depends_on[0] -eq 'variable-scope')
  Check '状态推进为 seen' ($detail.progress.concepts.closures.state -eq 'seen') ($detail.progress.concepts | ConvertTo-Json -Compress)
  Check '观察事件已记录' ($detail.progress.events.Count -ge 1)
  Check '对话已落盘' (($detail.chat.messages | Where-Object { $_.role -eq 'user' }).Count -ge 1)
  # 结构化布局的持久化端：题目卡片靠这条数据在刷新后恢复题面与作答
  $asked = @($detail.chat.messages | Where-Object { $_.questions })
  Check '出过的题随消息落盘' (($asked.Count -ge 1) -and ($asked[0].questions.Count -ge 1)) ($asked | ConvertTo-Json -Compress -Depth 6)
  Check '题面与作答结果都在' (($asked[0].questions[0].questionId -ne $null) -and ($asked[0].questions[0].answer.selected.Count -ge 1)) ($asked[0].questions[0] | ConvertTo-Json -Compress -Depth 6)
  Check '学习者视图是文字不是数字' ($detail.learnerView.counts.'正在学习' -eq 1) ($detail.learnerView.counts | ConvertTo-Json -Compress)
  Check '提问已记录到对话流（信号未丢）' (($events | Where-Object { $_.type -eq 'ask' }).Count -eq 2)

  Write-Host "`n6. 素材真的送进模型"
  $notesFile = Join-Path $env:TEMP 'faux-notes.md'
  Set-Content $notesFile "# 闭包笔记`n`nvar 在循环里共享同一个绑定，let 每轮各一个。" -Encoding utf8
  $fileBytes = [System.IO.File]::ReadAllBytes($notesFile)
  $up = Invoke-RestMethod "$base/api/notebooks/$id/uploads" -Method POST `
    -Headers @{ 'x-filename' = [uri]::EscapeDataString('faux-notes.md'); 'Content-Type' = 'application/octet-stream' } `
    -Body $fileBytes
  Check '素材上传成功' ($up.upload.kind -eq 'text') ($up.upload | ConvertTo-Json -Compress)

  # 重新装一份脚本：第一轮就把素材内容复述出来，用进度事件当证据
  $attachScript = @(
    @( @{ type = 'text'; text = '看到你的笔记了。' },
       @{ type = 'toolCall'; name = 'record_learning_event'; arguments = @{
           concept_id = 'closures'; kind = 'observed'
           summary = '素材已送达' } } ),
    @( @{ type = 'text'; text = '好，那我们从这个笔记继续。' } )
  )
  $attachScriptJson = $attachScript | ConvertTo-Json -Depth 20
  Invoke-RestMethod "$base/api/__faux" -Method POST -Headers $H -Body (@{ script = $attachScriptJson } | ConvertTo-Json) | Out-Null

  $nb2 = Invoke-RestMethod "$base/api/notebooks" -Method POST -Headers $H -Body (@{ topic = '素材测试' } | ConvertTo-Json)
  $id2 = $nb2.notebook.id
  $turnPayload = @{
    message = '这是我整理的一份笔记'
    attachments = @(@{ name = $up.upload.name; rel = $up.upload.rel; kind = 'text' })
    model = @{ provider = 'faux'; model = $fauxModelId }
  } | ConvertTo-Json -Depth 6

  $req2 = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, "$base/api/notebooks/$id2/turn")
  $req2.Content = [System.Net.Http.StringContent]::new($turnPayload, [Text.Encoding]::UTF8, 'application/json')
  $resp2 = $client.SendAsync($req2, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).Result
  $reader2 = [System.IO.StreamReader]::new($resp2.Content.ReadAsStreamAsync().Result, [Text.Encoding]::UTF8)
  $ev2 = New-Object System.Collections.ArrayList
  $dl2 = (Get-Date).AddSeconds(40)
  while (-not $reader2.EndOfStream -and (Get-Date) -lt $dl2) {
    $l = $reader2.ReadLine()
    if ($null -eq $l -or -not $l.StartsWith('data:')) { continue }
    $j = $l.Substring(5).Trim()
    if (-not $j) { continue }
    try { $e = $j | ConvertFrom-Json } catch { continue }
    [void]$ev2.Add($e)
    if ($e.type -eq 'closed') { break }
  }
  $reader2.Dispose()
  Check '带素材的回合跑完' (($ev2 | Where-Object { $_.type -eq 'done' }).Count -eq 1)
  $detail2 = (Invoke-RestMethod "$base/api/notebooks/$id2").notebook
  Check '素材事件已落盘（说明素材送达并被使用）' ($detail2.progress.events.Count -ge 1) ($detail2.progress.events | ConvertTo-Json -Compress)
  $uploads = (Invoke-RestMethod "$base/api/notebooks/$id").notebook.uploads
  Check '上传列表可见' ($uploads.Count -ge 1) ($uploads | ConvertTo-Json -Compress)
  Remove-Item $notesFile -Force -ErrorAction SilentlyContinue

  Write-Host "`n7. 回归：模型只回正文、不调任何工具时必须收尾"
  # 这是真实踩到的坑：模型输出一段正文就结束、没有工具调用，
  # 服务端此前直接 break 返回，谁也没发终止事件 → 浏览器永远转圈。
  # 回归：模型只回正文、不调任何工具时必须收尾
  # 这是真实踩到的坑：模型输出一段正文就结束、没有工具调用，
  # 服务端此前直接 break 返回，谁也没发终止事件 → 浏览器永远转圈。
  # 注意：这里用字面 JSON。PowerShell 的 ConvertTo-Json 会把嵌套单元素数组摊平，
  # 表现成 "blocks.map is not a function"。
  $plainJson = @'
[
  [ { "type": "text", "text": "欢迎！先让我了解你，好定制路线：" } ]
]
'@
  Invoke-RestMethod "$base/api/__faux" -Method POST -Headers $H -Body (@{ script = $plainJson } | ConvertTo-Json) | Out-Null

  $id4 = (Invoke-RestMethod "$base/api/notebooks" -Method POST -Headers $H -Body (@{ topic = '收尾回归' } | ConvertTo-Json)).notebook.id
  $req4 = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, "$base/api/notebooks/$id4/turn")
  $req4.Content = [System.Net.Http.StringContent]::new(
    (@{ message = '我要学习 github'; model = @{ provider = 'faux'; model = $fauxModelId } } | ConvertTo-Json),
    [Text.Encoding]::UTF8, 'application/json')
  $resp4 = $client.SendAsync($req4, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).Result
  $reader4 = [System.IO.StreamReader]::new($resp4.Content.ReadAsStreamAsync().Result, [Text.Encoding]::UTF8)
  $ev4 = New-Object System.Collections.ArrayList
  $dl4 = (Get-Date).AddSeconds(30)
  $sawClosed = $false
  while (-not $reader4.EndOfStream -and (Get-Date) -lt $dl4) {
    $l = $reader4.ReadLine()
    if ($null -eq $l -or -not $l.StartsWith('data:')) { continue }
    $j = $l.Substring(5).Trim()
    if (-not $j) { continue }
    try { $e = $j | ConvertFrom-Json } catch { continue }
    [void]$ev4.Add($e)
    if ($e.type -eq 'closed') { $sawClosed = $true; break }
  }
  $reader4.Dispose()
  $t4 = $ev4 | ForEach-Object { $_.type }
  Check '纯正文回合发出了 turn_end' ($t4 -contains 'turn_end') ($t4 -join ',')
  Check '纯正文回合发出了 done' ($t4 -contains 'done') ($t4 -join ',')
  Check '服务端关闭了连接（流不会挂着）' $sawClosed
  Check '纯正文没有报错' (-not (($ev4 | Where-Object { $_.type -eq 'error' }).Count)) (($ev4 | Where-Object { $_.type -eq 'error' } | ConvertTo-Json -Compress))
  $d4 = (Invoke-RestMethod "$base/api/notebooks/$id4").notebook
  Check '正文已落盘（不因缺终止事件而丢）' (($d4.chat.messages | Where-Object { $_.role -eq 'assistant' }).Count -eq 1) ($d4.chat.messages.Count)
  # 刷新后遗留回合的可观察性：turn-state 要能说清"还在跑 / 已跑完"
  $ts4 = Invoke-RestMethod "$base/api/notebooks/$id4/turn-state" -TimeoutSec 10
  Check '回合结束后 turn-state 报告空闲' ($ts4.active -eq $false) ($ts4 | ConvertTo-Json -Compress)
  Check '回合结束后服务端已释放（不再 409）' (
    (Invoke-RestMethod "$base/api/notebooks/$id4") -ne $null)

  Write-Host "`n8. 分身：taskRunner 必须真的接到工具上（组合根回归）"
  # 这一节是补上的：以前 runTurn 收了 taskRunner 却没往下传给 TeachingSession，
  # TaskRunner 的 registry 一直是 null，/task-stream 路由也不存在——六个任务类工具
  # 在真实应用里一律回"这个会话没有配置任务运行器"。单元测试是手工给 session 赋值
  # 绕开组合根的，所以那 420 项断言全绿也照不出这条。只有真起服务才看得见。
  $subJson = @'
[
  [ { "type": "toolCall", "name": "spawn_subagent", "arguments": { "title": "查一个字", "instructions": "请只回复一个字：好" } } ],
  [ { "type": "text", "text": "好" } ],
  [ { "type": "text", "text": "分身确认了：好。" } ]
]
'@
  Invoke-RestMethod "$base/api/__faux" -Method POST -Headers $H -Body (@{ script = $subJson } | ConvertTo-Json) | Out-Null
  $id5 = (Invoke-RestMethod "$base/api/notebooks" -Method POST -Headers $H -Body (@{ topic = '分身回归' } | ConvertTo-Json)).notebook.id

  # 先把常驻任务流挂上：分身的 task_start / task_end 走这条，不挂在回合流上
  $tsReq = [System.Net.Http.HttpRequestMessage]::new(
    [System.Net.Http.HttpMethod]::Get, "$base/api/notebooks/$id5/task-stream")
  $tsResp = $client.SendAsync($tsReq, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).Result
  Check 'task-stream 路由存在（以前 404）' ($tsResp.StatusCode -eq 200) "status=$($tsResp.StatusCode)"
  $tsReader = [System.IO.StreamReader]::new($tsResp.Content.ReadAsStreamAsync().Result, [Text.Encoding]::UTF8)

  $req5 = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, "$base/api/notebooks/$id5/turn")
  $req5.Content = [System.Net.Http.StringContent]::new(
    (@{ message = '派个分身查一下'; model = @{ provider = 'faux'; model = $fauxModelId } } | ConvertTo-Json),
    [Text.Encoding]::UTF8, 'application/json')
  $resp5 = $client.SendAsync($req5, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).Result
  $reader5 = [System.IO.StreamReader]::new($resp5.Content.ReadAsStreamAsync().Result, [Text.Encoding]::UTF8)
  $ev5 = New-Object System.Collections.ArrayList
  $dl5 = (Get-Date).AddSeconds(45)
  while (-not $reader5.EndOfStream -and (Get-Date) -lt $dl5) {
    $l = $reader5.ReadLine()
    if ($null -eq $l -or -not $l.StartsWith('data:')) { continue }
    $j = $l.Substring(5).Trim()
    if (-not $j) { continue }
    try { $e = $j | ConvertFrom-Json } catch { continue }
    [void]$ev5.Add($e)
    if ($e.type -eq 'closed') { break }
  }
  $reader5.Dispose()

  # 回合流读完再读任务流：事件早就缓存在 socket 里了，按行取即可
  $tsEvents = New-Object System.Collections.ArrayList
  for ($i = 0; $i -lt 20; $i++) {
    $t = $tsReader.ReadLineAsync()
    if (-not $t.Wait(1500)) { break }
    $l = $t.Result
    if ($null -eq $l) { break }
    if (-not $l.StartsWith('data:')) { continue }
    try { [void]$tsEvents.Add(($l.Substring(5).Trim() | ConvertFrom-Json)) } catch { continue }
  }
  $tsReader.Dispose()

  $subTask = @($tsEvents | Where-Object { $_.type -eq 'task_start' -and $_.task.kind -eq 'subagent' })
  Check '分身以 subagent 任务经 task-stream 外发' ($subTask.Count -ge 1) (($tsEvents | ForEach-Object { $_.type }) -join ',')
  $toolEnd = @($ev5 | Where-Object { $_.type -eq 'tool_end' -and $_.name -eq 'spawn_subagent' })
  Check '分身工具真的跑起来了（没回"没有配置任务运行器"）' (($toolEnd.Count -eq 1) -and ($toolEnd[0].ok -eq $true)) (($toolEnd | ConvertTo-Json -Compress -Depth 6))
  Check '分身的结论交回了主回合' ("$($toolEnd[0].result)" -match 'done') ($toolEnd[0].result | ConvertTo-Json -Compress -Depth 6)
  Check '任务事件经 task-stream 外发（task_start + task_end）' (
    ((@($tsEvents | Where-Object { $_.type -eq 'task_start' }).Count -ge 1) -and
     (@($tsEvents | Where-Object { $_.type -eq 'task_end' }).Count -ge 1))) ($tsEvents | ConvertTo-Json -Compress -Depth 4)
  $taskEnd = @($tsEvents | Where-Object { $_.type -eq 'task_end' })
  Check '分身结论落在任务记录里' ("$($taskEnd[0].task.output)" -match '好') ($taskEnd[0].task | ConvertTo-Json -Compress)
  $list5 = Invoke-RestMethod "$base/api/notebooks/$id5/tasks"
  Check '按学习列出任务（status=done）' ((@($list5.tasks).Count -eq 1) -and ($list5.tasks[0].status -eq 'done')) ($list5 | ConvertTo-Json -Compress -Depth 5)
  Check '纯正文回合正常收尾' (@($ev5 | Where-Object { $_.type -eq 'turn_end' }).Count -eq 1)

  Write-Host "`n9. 开局引导由模型现编（不写死那四条）"
  # 单元素数组会被 ConvertTo-Json 逐层拆掉，所以内层交给它、外层手工拼
  $starterBlocks = ConvertTo-Json -Depth 20 -Compress -InputObject @(, @{
    type = 'text'
    text = '[{"title":"为什么闰年这么麻烦","sub":"从一张日历开始"},{"title":"怎样让一段代码自己变快","sub":"先量再改"},{"title":"一首歌为什么抓耳","sub":"拆开听结构"},{"title":"合同里哪几句最贵","sub":"非法律岗"}]'
  })
  $starterScriptJson = "[$starterBlocks]"
  Invoke-RestMethod "$base/api/__faux" -Method POST -Headers $H -Body (@{ script = $starterScriptJson } | ConvertTo-Json) | Out-Null
  $st1 = Invoke-RestMethod "$base/api/starters"
  Check '引导现编出 4 条' (@($st1.starters).Count -eq 4) ($st1 | ConvertTo-Json -Compress)
  Check '条目的 title/sub 形状对前端可用' (($st1.starters[0].title -eq '为什么闰年这么麻烦') -and [bool]$st1.starters[0].sub) ($st1.starters[0] | ConvertTo-Json -Compress)
  # 第二次不再编：命中缓存就不会去消耗 faux 队列（队列已空，真去编就会拿不到回复）
  $st2 = Invoke-RestMethod "$base/api/starters"
  Check '第二次直接命中缓存（不重复烧一次调用）' (@($st2.starters).Count -eq 4) ($st2 | ConvertTo-Json -Compress)

  Write-Host "`n10. 未配置模型时的提示"
  $id3 = (Invoke-RestMethod "$base/api/notebooks" -Method POST -Headers $H -Body (@{ topic = '第三个学习' } | ConvertTo-Json)).notebook.id
  Invoke-RestMethod "$base/api/settings" -Method PUT -Headers $H -Body (@{ activeModel = $null } | ConvertTo-Json) | Out-Null
  $needModel = $false
  try { Invoke-RestMethod "$base/api/notebooks/$id3/turn" -Method POST -Headers $H -Body (@{ message = 'hi' } | ConvertTo-Json) }
  catch { $needModel = ($_.Exception.Response.StatusCode.value__ -eq 400) }
  Check '没选模型时明确要求先配置' $needModel
  # 刚建了「第三个学习」，已学清单变了 → 指纹变了 → 缓存作废，于是真的走到"没模型就交白卷"这一支
  $stNull = Invoke-RestMethod "$base/api/starters"
  Check '没配模型时引导交白卷（前端留静态四条）' ($null -eq $stNull.starters) ($stNull | ConvertTo-Json -Compress)

  Write-Host "`n11. 自定义端点：认不出的 id 一律 400，绝不许动别人的槽位"
  # 这个洞真踩过：customEndpointIndex 对认不出的 id 兜成 1 号槽，于是
  # PUT /api/custom-endpoints/__nope__ 把用户存好的第一个端点直接覆盖掉了。
  $epBody = @{ label = '测试端点'; baseUrl = 'http://127.0.0.1:1/v1'; modelId = 'm-slot1'; contextWindow = 4096 } | ConvertTo-Json
  Invoke-RestMethod "$base/api/custom-endpoints/custom-endpoint" -Method PUT -Headers $H -Body $epBody | Out-Null
  $before = @((Invoke-RestMethod "$base/api/custom-endpoints").endpoints)
  Check '1 号槽存好了一个端点' ($before.Count -eq 1 -and $before[0].modelId -eq 'm-slot1') ($before | ConvertTo-Json -Compress)
  $putStatus = 0
  try { Invoke-RestMethod "$base/api/custom-endpoints/__nope__" -Method PUT -Headers $H -Body $epBody | Out-Null }
  catch { $putStatus = $_.Exception.Response.StatusCode.value__ }
  Check '拼错的 id 直接 400' ($putStatus -eq 400) "status=$putStatus"
  $after = @((Invoke-RestMethod "$base/api/custom-endpoints").endpoints)
  Check '1 号槽原样还在（没被覆盖）' ($after.Count -eq 1 -and $after[0].modelId -eq 'm-slot1') ($after | ConvertTo-Json -Compress)
  $delStatus = 0
  try { Invoke-RestMethod "$base/api/custom-endpoints/custom-endpoint-0" -Method DELETE | Out-Null }
  catch { $delStatus = $_.Exception.Response.StatusCode.value__ }
  Check 'DELETE 也只认规矩 id（custom-endpoint-0 → 400）' ($delStatus -eq 400) "status=$delStatus"
  Check '被拒的 DELETE 没清掉 1 号槽' (@((Invoke-RestMethod "$base/api/custom-endpoints").endpoints).Count -eq 1)
  Invoke-RestMethod "$base/api/custom-endpoints/custom-endpoint" -Method DELETE | Out-Null
  Check '规矩 id 照旧删得掉' (@((Invoke-RestMethod "$base/api/custom-endpoints").endpoints).Count -eq 0)

  Write-Host "`n12. 笔记人机共同编辑：PUT / DELETE /api/notebooks/:id/notes/:noteId"
  # 笔记页从"只读"变成"学生能直接改"。这一节验的是：改得动、存得下、白名单外的字段写不进去、
  # 找不到对象时给 404 而不是 500。
  Invoke-RestMethod "$base/api/settings" -Method PUT -Headers $H -Body (@{ activeModel = @{ provider = 'faux'; model = $fauxModelId } } | ConvertTo-Json) | Out-Null
  $noteScript = @'
[
  [ { "type": "toolCall", "name": "compile_notes", "arguments": { "title": "原始标题", "summary": "原始摘要", "key_points": ["要点一"] } } ],
  [ { "type": "text", "text": "收好了。" } ]
]
'@
  Invoke-RestMethod "$base/api/__faux" -Method POST -Headers $H -Body (@{ script = $noteScript } | ConvertTo-Json) | Out-Null
  $id6 = (Invoke-RestMethod "$base/api/notebooks" -Method POST -Headers $H -Body (@{ topic = '笔记共同编辑' } | ConvertTo-Json)).notebook.id
  $req6 = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, "$base/api/notebooks/$id6/turn")
  $req6.Content = [System.Net.Http.StringContent]::new(
    (@{ message = '把刚才那个点收条笔记'; model = @{ provider = 'faux'; model = $fauxModelId } } | ConvertTo-Json),
    [Text.Encoding]::UTF8, 'application/json')
  $resp6 = $client.SendAsync($req6, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).Result
  $reader6 = [System.IO.StreamReader]::new($resp6.Content.ReadAsStreamAsync().Result, [Text.Encoding]::UTF8)
  $ev6 = New-Object System.Collections.ArrayList
  $dl6 = (Get-Date).AddSeconds(30)
  while (-not $reader6.EndOfStream -and (Get-Date) -lt $dl6) {
    $l = $reader6.ReadLine()
    if ($null -eq $l -or -not $l.StartsWith('data:')) { continue }
    $j = $l.Substring(5).Trim()
    if (-not $j) { continue }
    try { $e = $j | ConvertFrom-Json } catch { continue }
    [void]$ev6.Add($e)
    if ($e.type -eq 'closed') { break }
  }
  $reader6.Dispose()
  $noteId = @((Invoke-RestMethod "$base/api/notebooks/$id6").notebook.notes)[0].id
  Check 'compile_notes 经 HTTP 收到了一条笔记' ([bool]$noteId) ('事件：' + (($ev6 | ForEach-Object { $_.type }) -join ','))

  $putOut = Invoke-RestMethod "$base/api/notebooks/$id6/notes/$noteId" -Method PUT -Headers $H `
    -Body (@{ title = '学生自己改过的标题'; concepts = @('HACKED') } | ConvertTo-Json)
  Check 'PUT 改得动标题' ($putOut.note.title -eq '学生自己改过的标题') ($putOut | ConvertTo-Json -Compress)
  Check 'PUT 留下出处（服务端盖章，不是客户端自报）' (($putOut.note.edited_by -eq 'user') -and [bool]$putOut.note.edited_at) ($putOut.note | ConvertTo-Json -Compress)
  Check '白名单外的字段写不进去' (("$($putOut.note.concepts -join ',')" -notmatch 'HACKED')) ($putOut.note.concepts -join ',')
  Check '没给的字段还是原来的' ($putOut.note.summary -eq '原始摘要') $putOut.note.summary
  Check '改完真的落盘（刷新后还在）' ((Invoke-RestMethod "$base/api/notebooks/$id6").notebook.notes[0].title -eq '学生自己改过的标题')

  $missStatus = 0
  try { Invoke-RestMethod "$base/api/notebooks/$id6/notes/note-nope" -Method PUT -Headers $H -Body (@{ title = 'x' } | ConvertTo-Json) | Out-Null }
  catch { $missStatus = $_.Exception.Response.StatusCode.value__ }
  Check '改一条不存在的笔记给 404（不是 500）' ($missStatus -eq 404) "status=$missStatus"
  $goneStatus = 0
  try { Invoke-RestMethod "$base/api/notebooks/nb-nope/notes/$noteId" -Method PUT -Headers $H -Body (@{ title = 'x' } | ConvertTo-Json) | Out-Null }
  catch { $goneStatus = $_.Exception.Response.StatusCode.value__ }
  Check '学习不存在也是 404（不炸盘）' ($goneStatus -eq 404) "status=$goneStatus"

  $delOut = Invoke-RestMethod "$base/api/notebooks/$id6/notes/$noteId" -Method DELETE
  Check 'DELETE 删得掉' (($delOut.ok -eq $true) -and (@((Invoke-RestMethod "$base/api/notebooks/$id6").notebook.notes).Count -eq 0)) ($delOut | ConvertTo-Json -Compress)
  $del2 = 0
  try { Invoke-RestMethod "$base/api/notebooks/$id6/notes/$noteId" -Method DELETE | Out-Null }
  catch { $del2 = $_.Exception.Response.StatusCode.value__ }
  Check '再删一次给 404（不是假装删了）' ($del2 -eq 404) "status=$del2"
}
finally {
  if ($proc -and -not $proc.HasExited) { $proc.Kill() }
  Start-Sleep -Milliseconds 400
  Remove-Item $dataDir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "`n--- 服务端 stderr ---" -ForegroundColor DarkGray
  Get-Content $errLog -ErrorAction SilentlyContinue | Select-Object -First 15 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
}

Write-Host ("`n" + ('─' * 52))
Write-Host "通过 $passed 项，失败 $failed 项" -ForegroundColor $(if ($failed -eq 0) { 'Green' } else { 'Red' })
exit $(if ($failed -eq 0) { 0 } else { 1 })
