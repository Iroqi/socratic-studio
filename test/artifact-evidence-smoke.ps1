# 制品证据回端到端验证：脚本化一个交互制品，从制品内 postMessage 证据，
# 经 HTTP 落盘，下一回合的 system prompt 里能看到它。
#
# 验证 artifact.md §13.1 那条硬要求：「凡产出具交互性的制品，
# 其作答状态必须能被下一轮读到」——这条以前在应用里没有实现。
#
# 注意：faux 脚本一律用字面 JSON 写。PowerShell 的 ConvertTo-Json 会把嵌套
# 单元素数组摊平，表现成服务端报 "blocks.map is not a function"。

param([int]$Port = 8860)

$app = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$dataDir = Join-Path $env:TEMP ("socratic-art-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$tmp = Join-Path $env:TEMP ("art-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

$passed = 0; $failed = 0
function Check($name, $cond, $detail) {
  if ($cond) { $script:passed++; Write-Host "  OK   $name" -ForegroundColor Green }
  else { $script:failed++; Write-Host "  FAIL $name" -ForegroundColor Red; if ($detail) { Write-Host "       $detail" -ForegroundColor DarkGray } }
}

# ── 第一轮脚本：交付一个带契约标注的交互制品 ──────────────────────────
# faux 脚本以 JSON 文本直接 POST（/api/__faux 收 body.script，不再读服务端文件）
$script1 = @'
[
  [
    { "type": "text", "text": "我们先把画面摆出来。" },
    { "type": "toolCall", "name": "share_artifact", "arguments": {
        "title": "背包客：几个盒子",
        "kind": "interactive",
        "html": "<!doctype html><html><head><meta charset=\"utf-8\"><style>body{font-family:system-ui,\"Microsoft YaHei\",sans-serif;margin:0;padding:16px}</style></head><body>\n<div>循环结束时，内存里有几个 i？</div>\n<div data-interaction='{\"options\":[{\"id\":\"one\",\"label\":\"一个，三人共用\"},{\"id\":\"three\",\"label\":\"三个，一人一个\",\"correct\":true}]}'\n     data-interaction-type=\"choice\" data-concept-id=\"closures\" data-question-id=\"closures:q_box_count\">\n  <button data-choice-id=\"one\">一个，三人共用</button>\n  <button data-choice-id=\"three\">三个，一人一个</button>\n  <div class=\"interaction-feedback\" hidden></div>\n</div>\n</body></html>"
    } }
  ]
]
'@

# ── 第二轮脚本：读回证据 ────────────────────────────────────────────
$script2 = @'
[
  [ { "type": "toolCall", "name": "read_artifact_evidence", "arguments": {} } ],
  [ { "type": "text", "text": "我看到你试过了。" } ]
]
'@

$env:SOCRATIC_PORT = "$Port"; $env:SOCRATIC_DATA_DIR = $dataDir; $env:SOCRATIC_ENABLE_FAUX = '1'
$out = Join-Path $tmp 'out.log'; $err = Join-Path $tmp 'err.log'
$proc = Start-Process -FilePath 'node' -ArgumentList 'server/serve.mjs' -WorkingDirectory $app `
  -RedirectStandardOutput $out -RedirectStandardError $err -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 5

$base = "http://127.0.0.1:$Port"
$H = @{ 'Content-Type' = 'application/json' }

try {
  Write-Host "`n1. 建学习 + 装载脚本"
  $id = (Invoke-RestMethod "$base/api/notebooks" -Method POST -Headers $H -Body (@{ topic = 'JS 闭包' } | ConvertTo-Json)).notebook.id
  $models = (Invoke-RestMethod "$base/api/providers").availableModels | Where-Object { $_.provider -eq 'faux' }
  $fauxModel = $models[0].model
  $body = @{ provider = 'faux'; model = $fauxModel } | ConvertTo-Json
  Invoke-RestMethod "$base/api/settings" -Method PUT -Headers $H -Body $body | Out-Null
  Invoke-RestMethod "$base/api/__faux" -Method POST -Headers $H -Body (@{ script = $script1 } | ConvertTo-Json) | Out-Null
  Check '脚本装载成功' $true

  Write-Host "`n2. 第一回合：交付制品"
  Add-Type -AssemblyName System.Net.Http
  $client = [System.Net.Http.HttpClient]::new(); $client.Timeout = [TimeSpan]::FromSeconds(60)
  $Run = {
    param($msg)
    $req = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, "$base/api/notebooks/$id/turn")
    $req.Content = [System.Net.Http.StringContent]::new(
      (@{ message = $msg; model = @{ provider = 'faux'; model = $fauxModel } } | ConvertTo-Json),
      [Text.Encoding]::UTF8, 'application/json')
    $r = $client.SendAsync($req, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).Result
    $rd = [System.IO.StreamReader]::new($r.Content.ReadAsStreamAsync().Result, [Text.Encoding]::UTF8)
    $evs = New-Object System.Collections.ArrayList
    while (-not $rd.EndOfStream) {
      $l = $rd.ReadLine()
      if ($null -eq $l -or -not $l.StartsWith('data:')) { continue }
      $j = $l.Substring(5).Trim(); if (-not $j) { continue }
      try { $e = $j | ConvertFrom-Json } catch { continue }
      [void]$evs.Add($e); if ($e.type -eq 'closed') { break }
    }
    $rd.Dispose(); return $evs
  }
  $ev1 = & $Run '教我闭包'
  $art = $ev1 | Where-Object { $_.type -eq 'artifact' }
  Check '制品事件发出' ($art.Count -eq 1)
  Check '制品标注"可作答"（expectsEvidence）' ($art.artifact.expectsEvidence -eq $true) "expectsEvidence=$($art.artifact.expectsEvidence)"
  Check '运行时已注入制品' ([bool]$art.artifact.html -and $art.artifact.html.Contains('data-socratic-runtime'))
  Check '制品含题号标注' ($art.artifact.html.Contains('data-question-id="closures:q_box_count"'))
  # 道具恒有地址：事件里就带上那条可取用的 rel（以前没带 persist 的那一支只有 inline-N 合成号）。
  $artId = $art.artifact.id
  Check '制品事件自带地址（rel 指的就是这个 id 的目录）' ($art.artifact.rel -eq "artifacts/$artId/index.html") "id=$artId rel=$($art.artifact.rel)"

  Write-Host "`n3. 制品内作答 → postMessage → HTTP 回传"
  Invoke-RestMethod "$base/api/notebooks/$id/artifact-message" -Method POST -Headers $H -Body (@{
    type = 'evidence'; artifactId = $artId; evidence = @{
      concept_id = 'closures'; question_id = 'closures:q_box_count'; interaction_type = 'choice'
      response = 'one'; result = 'incorrect'; attempts = 1; completed = $false; locked = $false }
  } | ConvertTo-Json -Depth 5) | Out-Null
  Invoke-RestMethod "$base/api/notebooks/$id/artifact-message" -Method POST -Headers $H -Body (@{
    type = 'evidence'; artifactId = $artId; evidence = @{
      concept_id = 'closures'; question_id = 'closures:q_box_count'; interaction_type = 'choice'
      response = 'three'; result = 'correct'; attempts = 2; completed = $true; locked = $true }
  } | ConvertTo-Json -Depth 5) | Out-Null

  Write-Host "`n4. 证据落盘"
  $saved = (Invoke-RestMethod "$base/api/notebooks/$id").notebook.progress.artifact_evidence
  Check '证据已落盘（2 条）' ($saved.Count -eq 2) "$($saved.Count) 条"
  Check '先错后对两次作答都保留' (($saved | Where-Object { $_.attempts -eq 1 -and $_.result -eq 'incorrect' }).Count -eq 1 -and ($saved | Where-Object { $_.attempts -eq 2 -and $_.result -eq 'correct' }).Count -eq 1)
  Check '证据带题号坐标' ($saved[0].question_id -eq 'closures:q_box_count')
  Check '证据不含数值化字段' (-not (($saved | ConvertTo-Json -Compress) -match 'score|percent|pct'))
  # 重复证据应被去重：同一份再 POST 一次，落盘条数不增长
  $dupBody = @{
    type = 'evidence'; artifactId = $artId; evidence = @{
      concept_id = 'closures'; question_id = 'closures:q_box_count'; interaction_type = 'choice'
      response = 'three'; result = 'correct'; attempts = 2; completed = $true; locked = $true }
  } | ConvertTo-Json -Depth 5
  Invoke-RestMethod "$base/api/notebooks/$id/artifact-message" -Method POST -Headers $H -Body $dupBody | Out-Null
  $afterDup = (Invoke-RestMethod "$base/api/notebooks/$id").notebook.progress.artifact_evidence
  Check '重复证据被去重（条数不增长）' ($afterDup.Count -eq 2) "dup 后 = $($afterDup.Count) 条"

  Write-Host "`n4b. 项目 / 游戏：state 快照 + event 流水"
  # state 是覆盖式快照：同一 artifact 后写的键覆盖先写的
  Invoke-RestMethod "$base/api/notebooks/$id/artifact-message" -Method POST -Headers $H -Body (
    '{"type":"state","artifactId":"game-1","state":{"level":2,"attempts":1,"hp":80}}'
  ) | Out-Null
  Invoke-RestMethod "$base/api/notebooks/$id/artifact-message" -Method POST -Headers $H -Body (
    '{"type":"state","artifactId":"game-1","state":{"level":3,"build":"tower-a"}}'
  ) | Out-Null
  $st = (Invoke-RestMethod "$base/api/notebooks/$id").notebook.progress.artifact_state
  Check 'state 浅合并且后写覆盖（level=3）' ($st.'game-1'.level -eq 3) "level=$($st.'game-1'.level)"
  Check 'state 保留未被覆盖的键（hp=80）' ($st.'game-1'.hp -eq 80) "hp=$($st.'game-1'.hp)"
  Check 'state 不含评分字段' (-not (($st | ConvertTo-Json -Compress -Depth 4) -match 'score|mastery|percent'))
  # event 只追加，且按 name+at 去重
  $evBody = '{"type":"event","artifactId":"game-1","name":"level_cleared","payload":{"level":2},"at":"2026-01-01T00:00:00.000Z"}'
  Invoke-RestMethod "$base/api/notebooks/$id/artifact-message" -Method POST -Headers $H -Body $evBody | Out-Null
  Invoke-RestMethod "$base/api/notebooks/$id/artifact-message" -Method POST -Headers $H -Body $evBody | Out-Null
  Invoke-RestMethod "$base/api/notebooks/$id/artifact-message" -Method POST -Headers $H -Body (
    '{"type":"event","artifactId":"game-1","name":"build_succeeded","payload":{"build":"tower-a"}}'
  ) | Out-Null
  $evs = (Invoke-RestMethod "$base/api/notebooks/$id").notebook.progress.artifact_events
  Check 'event 追加且同 name+at 去重（2 条）' ($evs.Count -eq 2) "$($evs.Count) 条"
  Check 'event 保留 name 与 payload' ($evs[0].name -eq 'level_cleared' -and $evs[0].payload.level -eq 2)

  Write-Host "`n4c. 道具的寿命：扔掉 / 放回（软退役，走 HTTP 全链路）"
  # 学习者那一颗「扔掉」点出来的就是这条路。这一节钉三件事：只盖时间戳、绝不删文件、
  # 事件名进得了流水（模型下一轮读得到的就是那一行）。
  $life = "$base/api/notebooks/$id/artifacts/$artId/lifetime"
  $dropRes = Invoke-RestMethod $life -Method POST -Headers $H -Body (@{ retired = $true } | ConvertTo-Json)
  Check '扔掉返回 200 + 带时间戳的那一条' ([bool]$dropRes.artifact.retiredAt) ($dropRes.artifact | ConvertTo-Json -Compress)
  $afterDrop = (Invoke-RestMethod "$base/api/notebooks/$id").notebook
  Check '扔掉之后文件还在盘上（地址照样取回 HTML，这才是"能反着走"）' `
    ((Invoke-WebRequest "$base/api/notebooks/$id/artifacts/$artId").StatusCode -eq 200)
  Check 'manifest 那一行没被删（「素材」页靠它列出扔掉的那件）' `
    ($afterDrop.artifacts.Count -eq 1 -and $afterDrop.artifacts[0].id -eq $artId) "$($afterDrop.artifacts.Count) 件"
  # 每一处读盘结果都先 @() 兜住：这一节要能在"事件根本没落盘"时一条条红着说完，
  # 不许让 $null 的属性访问把整条链路截断（截断了就看不见后面那两条也该红的）。
  $lifeEvents = @(@($afterDrop.progress.artifact_events) | Where-Object { $_.name -like 'artifact_*' })
  Check '流水里落下 artifact_retired（扔掉这一手必须落盘，不是只在内存里改一笔）' `
    ($lifeEvents.Count -eq 1 -and $lifeEvents[0].name -eq 'artifact_retired') "条数=$($lifeEvents.Count)"
  Check '那条事件说清撤的是哪件（payload 带标题，模型不必猜 id）' ($lifeEvents[0].payload.title -eq $art.artifact.title) "title=$($lifeEvents[0].payload.title)"

  $backRes = Invoke-RestMethod $life -Method POST -Headers $H -Body (@{ retired = $false } | ConvertTo-Json)
  Check '放回抹掉了时间戳（整件替换，不是塞个 null 进去）' `
    (-not ($backRes.artifact.PSObject.Properties.Name -contains 'retiredAt')) ($backRes.artifact | ConvertTo-Json -Compress)
  $restoredEvent = @(@((Invoke-RestMethod "$base/api/notebooks/$id").notebook.progress.artifact_events) |
    Where-Object { $_.name -eq 'artifact_restored' })
  Check '放回也落一条 artifact_restored（两个方向都是事实）' ($restoredEvent.Count -eq 1) "条数=$($restoredEvent.Count)"

  # 这条路由学习者的点击驱动，输入不许当成路径或状态用。
  $badCode = 0
  try { Invoke-RestMethod $life -Method POST -Headers $H -Body (@{ retired = 'yes' } | ConvertTo-Json) | Out-Null }
  catch { $badCode = $_.Exception.Response.StatusCode.value__ }
  Check 'retired 不是布尔就 400（不许把字符串当真假用）' ($badCode -eq 400) "code=$badCode"
  $missCode = 0
  try { Invoke-RestMethod "$base/api/notebooks/$id/artifacts/no-such-prop/lifetime" -Method POST -Headers $H -Body (@{ retired = $true } | ConvertTo-Json) | Out-Null }
  catch { $missCode = $_.Exception.Response.StatusCode.value__ }
  Check 'manifest 里没有的那件报 404（不许静默成功）' ($missCode -eq 404) "code=$missCode"
  # 还没开过场时这一手也不许炸：旧会话根本没有 scene.json，「扔掉」仍然只是改一件道具的寿命，
  # 扯不到台面上去（响应里 current 是 null，而不是 500）。
  Check '没开过场时扔掉/放回都不碰台面（没有 scene.json 也要能扔）' `
    ($null -eq $dropRes.scene.current -and $null -eq $backRes.scene.current) "current=$($dropRes.scene.current)"

  Write-Host "`n4d. 台面跟着手势走（导演台 ↔ lifetime）"
  # 开一场、把上面那件道具摆上台，再走学习者那一颗「扔掉」——道具必须自己下台。
  # 这一节钉的是 serve.mjs 里那两条分支：既要写盘也要回给前端，只做一半都算红。
  $script3 = @"
[
  [ { "type": "toolCall", "name": "run_scene", "arguments": { "action": "open", "title": "第一场：几个盒子", "concept_id": "closures" } } ],
  [ { "type": "toolCall", "name": "run_scene", "arguments": { "action": "place", "artifact_id": "$artId" } } ],
  [ { "type": "text", "text": "东西摆好了。" } ]
]
"@
  Invoke-RestMethod "$base/api/__faux" -Method POST -Headers $H -Body (@{ script = $script3 } | ConvertTo-Json) | Out-Null
  $ev3 = & $Run '开一场'
  $sceneEvs = @($ev3 | Where-Object { $_.type -eq 'scene' })
  Check '台面变化推给前端（开场、摆道具各一次，不是只写在盘上）' ($sceneEvs.Count -eq 2) "次数=$($sceneEvs.Count)"
  $desk3 = (Invoke-RestMethod "$base/api/notebooks/$id").notebook.scene
  Check '场落盘：第 1 场、场名、相位停在开场' `
    ($desk3.current.index -eq 1 -and $desk3.current.title -eq '第一场：几个盒子' -and $desk3.current.phase -eq 'open') `
    "index=$($desk3.current.index) title=$($desk3.current.title) phase=$($desk3.current.phase)"
  Check 'run_scene 真把道具搬上台（台上就那一件）' `
    (@($desk3.current.props).Count -eq 1 -and $desk3.current.props[0].id -eq $artId) `
    "台上=$((@($desk3.current.props) | ForEach-Object { $_.title }) -join ',')"
  $deskDrop = Invoke-RestMethod $life -Method POST -Headers $H -Body (@{ retired = $true } | ConvertTo-Json)
  Check '扔掉把道具带下台（返回值里台面就空了，前端不必重算）' `
    (@($deskDrop.scene.current.props).Count -eq 0) "返回值里台上 $(@($deskDrop.scene.current.props).Count) 件"
  $deskAfterDrop = (Invoke-RestMethod "$base/api/notebooks/$id").notebook.scene
  Check '那一次也真写了盘（不是只改了响应）' (@($deskAfterDrop.current.props).Count -eq 0) `
    "盘上 $(@($deskAfterDrop.current.props).Count) 件"
  # 台面只认 props 这一本账：placed / removed 是 2a 早期的废账（没有读者、还会跟 props 打脸）。
  # "这件被撤下过"这件事归 4c 那条 artifact_retired 流水说，记录里不许再长出第二处。
  $curProps = $deskAfterDrop.current.PSObject.Properties.Name
  Check '撤下之后记录里没有第二本账（placed / removed 随这一刀退役）' `
    (-not ($curProps -contains 'placed') -and -not ($curProps -contains 'removed')) `
    "键=$($curProps -join ',')"
  $deskBack = Invoke-RestMethod $life -Method POST -Headers $H -Body (@{ retired = $false } | ConvertTo-Json)
  Check '放回把同一件送回当前这一场（同一个 id，不是复制出一件新的）' `
    (@($deskBack.scene.current.props).Count -eq 1 -and $deskBack.scene.current.props[0].id -eq $artId) `
    "放回后台上 $(@($deskBack.scene.current.props).Count) 件"

  Write-Host "`n4e. 回合正卡着的时候扔掉：活回合内存里那一份也得跟着走"
  # 4d 钉的是这一手写的盘；这一节钉的是同一个回合里 session 内存中的那一份 scene。
  # 场景是真的会发生的：模型卡在题上等人答，学习者趁这会儿点「扔掉」，
  # 答完模型接着调 run_scene——它读写的是内存里那一份，不同步就把刚扔掉的那件又写回台上。
  $script4 = @"
[
  [ { "type": "toolCall", "name": "ask_user_question", "arguments": { "id": "live:q_drop", "concept_id": "closures", "header": "看一下台面", "question": "我先把这件撤下来，接着往下讲？", "options": [ { "label": "嗯，接着讲" }, { "label": "先停这儿" } ] } } ],
  [ { "type": "toolCall", "name": "run_scene", "arguments": { "action": "phase", "phase": "teach" } } ],
  [ { "type": "text", "text": "接着往下讲。" } ]
]
"@
  Invoke-RestMethod "$base/api/__faux" -Method POST -Headers $H -Body (@{ script = $script4 } | ConvertTo-Json) | Out-Null
  $req4 = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, "$base/api/notebooks/$id/turn")
  $req4.Content = [System.Net.Http.StringContent]::new(
    (@{ message = '接着演这一场'; model = @{ provider = 'faux'; model = $fauxModel } } | ConvertTo-Json),
    [Text.Encoding]::UTF8, 'application/json')
  $resp4 = $client.SendAsync($req4, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).Result
  $rd4 = [System.IO.StreamReader]::new($resp4.Content.ReadAsStreamAsync().Result, [Text.Encoding]::UTF8)
  $ev4 = New-Object System.Collections.ArrayList
  $midAsk = $false
  $propsMid = -1
  $deadline4 = (Get-Date).AddSeconds(60)
  while (-not $rd4.EndOfStream -and (Get-Date) -lt $deadline4) {
    $l = $rd4.ReadLine()
    if ($null -eq $l -or -not $l.StartsWith('data:')) { continue }
    $j = $l.Substring(5).Trim(); if (-not $j) { continue }
    try { $e = $j | ConvertFrom-Json } catch { continue }
    [void]$ev4.Add($e)
    if ($e.type -eq 'ask' -and -not $midAsk) {
      $midAsk = $true
      # 回合还开着（卡在题上等），这时候打的就是学习者卡片上那一颗「扔掉」
      Invoke-RestMethod $life -Method POST -Headers $H -Body (@{ retired = $true } | ConvertTo-Json) | Out-Null
      $propsMid = @((Invoke-RestMethod "$base/api/notebooks/$id").notebook.scene.current.props).Count
      $ac4 = [System.Net.Http.StringContent]::new(
        (@{ questionId = $e.questionId; selected = @('嗯，接着讲') } | ConvertTo-Json),
        [Text.Encoding]::UTF8, 'application/json')
      $ar4 = $client.PostAsync("$base/api/notebooks/$id/answer", $ac4).Result
      Check '卡在题上的回合收得住作答（那一手的窗口里 HTTP 照样进得来）' ($ar4.StatusCode -eq 200) "status=$($ar4.StatusCode)"
    }
    if ($e.type -eq 'closed') { break }
  }
  $rd4.Dispose()
  Check '这一回合真的跑到了题（不然中间那一笔没打着活回合）' $midAsk (($ev4 | ForEach-Object { $_.type }) -join ',')
  Check '扔掉那一刻盘上台面空了' ($propsMid -eq 0) "props=$propsMid"
  $deskEnd = (Invoke-RestMethod "$base/api/notebooks/$id").notebook.scene
  Check '模型接着推相位也没把那件写回台上（内存里那一份跟着手势走）' `
    (@($deskEnd.current.props).Count -eq 0 -and $deskEnd.current.phase -eq 'teach') `
    "台上 $(@($deskEnd.current.props).Count) 件｜相位=$($deskEnd.current.phase)"
  $scenePush4 = @($ev4 | Where-Object { $_.type -eq 'scene' })
  Check '推给前端那一份也是空的台面（不是只改了盘、前端还摆着旧的那件）' `
    ($scenePush4.Count -eq 1 -and @($scenePush4[-1].scene.props).Count -eq 0) `
    "次数=$($scenePush4.Count) 件=$(@($scenePush4[-1].scene.props).Count)"

  Write-Host "`n5. 下一回合：证据进入 system prompt"
  Invoke-RestMethod "$base/api/__faux" -Method POST -Headers $H -Body (@{ script = $script2 } | ConvertTo-Json) | Out-Null
  $ev2 = & $Run '我试完了'
  Check 'read_artifact_evidence 被模型调用' (($ev2 | Where-Object { $_.type -eq 'tool_exec' -and $_.name -eq 'read_artifact_evidence' }).Count -eq 1) "$(($ev2 | Where-Object { $_.type -eq 'tool_exec' }).Count) 次工具"
  Check '没有 error 事件' (-not (($ev2 | Where-Object { $_.type -eq 'error' }).Count))
  # 证据注入 system prompt 的逐字段断言在 test/run.mjs（Node 侧直接调纯函数，
  # 比在 PowerShell 里拼 node -e 可靠得多）。这里只确认整条链路没把数据弄丢。
  $finalNb = (Invoke-RestMethod "$base/api/notebooks/$id").notebook
  Check '证据在 notebook 里可见（链路未断）' ($finalNb.progress.artifact_evidence.Count -eq 2) "$($finalNb.progress.artifact_evidence.Count) 条"
  Check '制品落盘了：notebook.artifacts 里有这一件，地址对得上' `
    ($finalNb.artifacts.Count -eq 1 -and $finalNb.artifacts[0].rel -eq "artifacts/$artId/index.html") `
    "$($finalNb.artifacts.Count) 件 | rel=$($finalNb.artifacts[0].rel)"
  $fetched = Invoke-WebRequest "$base/api/notebooks/$id/artifacts/$artId"
  Check '那条地址真能取回 HTML，而且宿主给了不透明源（CSP sandbox + nosniff）' `
    ($fetched.Headers['Content-Security-Policy'] -match 'sandbox' -and $fetched.Content.Contains('data-socratic-runtime')) `
    "csp=$($fetched.Headers['Content-Security-Policy'])"
}
finally {
  if ($proc -and -not $proc.HasExited) { $proc.Kill() }
  Start-Sleep -Milliseconds 400
  Remove-Item $dataDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "`n--- 服务端 stderr ---" -ForegroundColor DarkGray
  Get-Content $err -ErrorAction SilentlyContinue | Select-Object -First 10 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
}

Write-Host ("`n" + ('─' * 52))
Write-Host "通过 $passed 项，失败 $failed 项" -ForegroundColor $(if ($failed -eq 0) { 'Green' } else { 'Red' })
exit $(if ($failed -eq 0) { 0 } else { 1 })
