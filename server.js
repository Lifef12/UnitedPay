<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
<title>AlphaX - Free SHIBA Mining</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; user-select: none; }
body { background: #000; color: #fff; display: flex; justify-content: center; min-height: 100vh; padding: 15px 0 110px 0; overflow-x: hidden; }

#toast-notification { position: fixed; top: 15px; left: 50%; transform: translateX(-50%) translateY(-100px); background: #140d28; color: #fff; padding: 14px 18px; border-radius: 18px; font-size: 13px; font-weight: 800; display: flex; align-items: center; gap: 12px; box-shadow: 0 12px 30px rgba(0,0,0,.6); border: 1px solid #7c3aed; z-index: 999999999; transition: transform .3s cubic-bezier(.175,.885,.32,1.275); width: 92%; max-width: 400px; }
#toast-notification.show { transform: translateX(-50%) translateY(0); }
#toast-notification i { color: #00ff66; font-size: 18px; background: rgba(0,255,102,.15); padding: 8px; border-radius: 50%; }

/* Splash */
#splash-screen { position: fixed; inset: 0; background: #000; display: flex; flex-direction: column; justify-content: center; align-items: center; z-index: 999999999; transition: opacity .5s ease; }
.loader-ring-box { position: relative; width: 170px; height: 170px; display: flex; justify-content: center; align-items: center; }
.loader-ring { position: absolute; width: 170px; height: 170px; border: 4px solid #112211; border-top: 4px solid #00ff66; border-radius: 50%; animation: spin 1s linear infinite; }
.loader-logo-img { width: 115px; height: 115px; border-radius: 50%; object-fit: cover; border: 2px solid #00ff66; box-shadow: 0 0 25px rgba(0,255,102,.5); background: #151b26; }
.loading-text { color: #00ff66; font-size: 16px; font-weight: 800; letter-spacing: 5px; margin-top: 35px; animation: pulse 1.5s infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes pulse { 0%,100% { opacity: .4; } 50% { opacity: 1; } }

/* Verification */
#verification-screen { position: fixed; inset: 0; background: linear-gradient(160deg,#3a1030 0%,#0d0720 45%,#050310 100%); display: none; flex-direction: column; justify-content: center; align-items: center; z-index: 99999999; padding: 20px; text-align: center; overflow-y: auto; }
.verify-logo-box { width: 100px; height: 100px; background: #000; border-radius: 26px; display: flex; justify-content: center; align-items: center; border: 2px solid #5b21b6; position: relative; z-index: 2; overflow: hidden; box-shadow: 0 0 25px rgba(57,255,20,.35); flex-shrink: 0; }
.verify-card { background: rgba(18,12,38,.95); border: 1px solid rgba(124,58,237,.5); width: 100%; max-width: 380px; border-radius: 36px; padding: 50px 20px 24px; margin-top: -45px; }
.channel-item { background: #1f1936; border: 1px solid #3b1f78; border-radius: 22px; padding: 12px 16px; margin: 10px 0; display: flex; justify-content: space-between; align-items: center; text-decoration: none; color: #a78bfa; transition: .2s; }
.channel-item:active { background: #2a1f4a; }
.channel-info { display: flex; align-items: center; gap: 14px; text-align: left; }
.channel-badge { background: #5b21b6; color: #b6f03c; font-size: 15px; font-weight: 900; padding: 14px 12px; border-radius: 14px; }
.channel-details h5 { font-size: 16px; font-weight: 900; color: #fff; }
.channel-details span { font-size: 13px; color: #a78bfa; }

.app-container { width: 100%; max-width: 420px; background: linear-gradient(180deg,#0b0d1a 0%,#070a14 100%); padding: 15px; text-align: center; position: relative; z-index: 1; }
.user-profile-header { display: flex; justify-content: space-between; align-items: center; background: #120b22; border: 1px solid #23163c; border-radius: 18px; padding: 12px 15px; margin-bottom: 15px; }
.user-info-left { display: flex; align-items: center; gap: 10px; text-align: left; }
.user-avatar { width: 42px; height: 42px; border-radius: 50%; background: #1c1333; color: #f5a623; display: flex; justify-content: center; align-items: center; font-size: 18px; border: 2px solid #f5a623; }
.user-details h4 { font-size: 14px; font-weight: 800; color: #fff; }
.user-details span { font-size: 11px; color: #a78bfa; font-weight: 700; }
.bot-brand-right { display: flex; align-items: center; gap: 8px; }
.bot-mini-logo { width: 34px; height: 34px; border-radius: 50%; background: #000; display: flex; justify-content: center; align-items: center; border: 1px solid #00ff66; overflow: hidden; }
.bot-mini-logo img { width: 100%; height: 100%; object-fit: cover; }
.bot-brand-right span { font-size: 14px; font-weight: 900; color: #f5a623; letter-spacing: 1px; }

.title-header { color: #fff; font-size: 20px; font-weight: 900; margin: 10px 0 18px 0; text-align: left; display: flex; align-items: center; gap: 8px; }
.card { background: #120b22; border: 1px solid #23163c; border-radius: 22px; padding: 18px; margin-bottom: 15px; text-align: left; color: #fff; }
.card-center { text-align: center; }
.card-label { font-size: 11px; color: #a78bfa; font-weight: 700; letter-spacing: 1px; display: block; }

.btn { border: none; border-radius: 14px; font-weight: 800; padding: 14px; cursor: pointer; font-size: 13px; width: 100%; text-align: center; transition: .2s; }
.btn-green { background: #f5a623; color: #000; font-weight: 900; box-shadow: 0 4px 15px rgba(245,166,35,.3); }
.btn-purple { background: #6d28d9; color: #fff; }
.btn-dark { background: #1c1333; color: #fff; border: 1px solid #2e1e52; }
.btn-disabled { background: #23163c; color: #6b7280; cursor: not-allowed; }
#verify-btn { background: #3f1f6e; border: 1px solid #5b21b6; border-radius: 22px; padding: 20px; font-size: 18px; margin-top: 15px; }

.mining-active-box { background: #170e2b; border: 1px solid #f5a623; border-radius: 20px; padding: 18px; margin-top: 10px; text-align: left; }
.progress-bar-bg { width: 100%; height: 8px; background: #23163c; border-radius: 10px; margin: 12px 0 18px 0; overflow: hidden; }
.progress-bar-fill { width: 100%; height: 100%; background: #f5a623; border-radius: 10px; }

.task-pills { display: flex; gap: 8px; margin-bottom: 15px; }
.task-pill { flex: 1; padding: 10px; font-size: 11px; font-weight: 800; border-radius: 12px; background: #1c1333; color: #a78bfa; border: 1px solid #2e1e52; text-align: center; }
.task-pill.active { background: linear-gradient(135deg,#fbbf24,#f59e0b); color: #000; border-color: #f59e0b; }
.task-pill{cursor:pointer}

.checkin-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin: 15px 0; }
.checkin-box { background: #1c1333; border: 1px solid #2e1e52; border-radius: 16px; padding: 12px 8px; text-align: center; }
.checkin-box.done { border-color: #f5a623; }

.trx-input-wrapper { position: relative; display: flex; align-items: center; margin: 8px 0 12px 0; }
.trx-input-wrapper input { width: 100%; padding: 12px 60px 12px 14px; border-radius: 14px; border: 1px solid #2e1e52; background: #1c1333; color: #fff; font-size: 11px; font-weight: bold; }
.trx-copy-btn { position: absolute; right: 6px; background: #6d28d9; color: #fff; border: none; padding: 8px 14px; border-radius: 10px; font-size: 11px; font-weight: 800; cursor: pointer; }
.input-group { position: relative; margin: 8px 0 15px 0; display: flex; align-items: center; }
.input-group i { position: absolute; left: 14px; color: #f5a623; font-size: 16px; }
.input-group input { width: 100%; padding: 12px 12px 12px 42px; border-radius: 12px; border: 1px solid #2e1e52; background: #1c1333; color: #fff; font-size: 14px; font-weight: bold; user-select: text; }
.max-btn { position: absolute; right: 8px; background: #f5a623; color: #000; border: none; padding: 6px 10px; border-radius: 8px; font-size: 11px; font-weight: bold; cursor: pointer; }

.history-item { background: #1c1333; border: 1px solid #2e1e52; padding: 12px; border-radius: 14px; margin-top: 8px; font-size: 12px; display: flex; justify-content: space-between; align-items: center; text-align: left; }
.status-badge { padding: 4px 8px; border-radius: 6px; font-size: 10px; font-weight: bold; background: #fef08a; color: #854d0e; text-transform: uppercase; }

.bottom-nav { position: fixed; bottom: 15px; left: 50%; transform: translateX(-50%); width: 92%; max-width: 400px; background: #000; border: 1px solid #23163c; display: flex; justify-content: space-around; align-items: center; padding: 8px 10px; z-index: 999999; border-radius: 28px; box-shadow: 0 10px 30px rgba(0,0,0,.8); }
.nav-item { color: #6b7280; text-decoration: none; display: flex; flex-direction: column; align-items: center; font-size: 11px; font-weight: 700; gap: 4px; flex: 1; cursor: pointer; }
.nav-item i { font-size: 20px; }
.nav-item.active { color: #f5a623; }
.nav-mining-btn { width: 52px; height: 52px; background: #f5a623; border-radius: 18px; display: flex; justify-content: center; align-items: center; color: #000; font-size: 22px; margin-top: -24px; border: 4px solid #000; box-shadow: 0 0 15px rgba(245,166,35,.4); }
.nav-item.active .nav-mining-btn { background: #00ff66; box-shadow: 0 0 20px rgba(0,255,102,.7); }

.tab-content { display: none; }
.tab-content.active { display: block; }

.ticker{display:flex;align-items:center;gap:10px;background:#101426;border:1px solid #232a44;border-radius:18px;padding:12px 14px;font-size:12px;font-weight:700;color:#f5c26b;text-align:left;margin-bottom:14px}
.live-pill{background:linear-gradient(135deg,#fbbf24,#f59e0b);color:#000;font-weight:900;font-size:11px;padding:6px 10px;border-radius:10px;letter-spacing:1px}
.eyebrow{font-size:11px;letter-spacing:3px;color:#f5a623;font-weight:800;text-align:left;margin:6px 0 2px}
.dash-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
.dash-title{font-size:30px;font-weight:900;color:#fff}
.plan-pill{display:flex;align-items:center;gap:8px;background:#101426;border:1px solid #232a44;border-radius:20px;padding:10px 14px;font-size:12px;font-weight:800;color:#e5e7eb}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#10d98c}
.balance-card{background:linear-gradient(160deg,#2a1d08 0%,#0f1426 55%);border:1px solid #5b4213;border-radius:26px;padding:20px;margin-bottom:14px;text-align:left}
.bal-top{display:flex;justify-content:space-between;align-items:center}
.bal-label{font-size:12px;letter-spacing:3px;color:#cbd5e1;font-weight:800}
.earn-pill{display:flex;align-items:center;gap:6px;background:#0d2a26;border:1px solid #146c57;color:#34d399;font-size:11px;font-weight:800;padding:6px 10px;border-radius:14px}
.bal-amount{text-align:center;font-size:36px;font-weight:900;color:#fff;margin:22px 0 18px}
.bal-amount small{font-size:14px;color:#cbd5e1;font-weight:800}
.bal-actions{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.btn-gold{background:linear-gradient(135deg,#fbbf24,#f59e0b);color:#000;font-weight:900;border-radius:18px;box-shadow:0 6px 18px rgba(245,166,35,.3);padding:15px 6px}
.stat-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}
.stat{background:#0f1426;border:1px solid #232a44;border-radius:18px;padding:14px 6px;text-align:center}
.stat span{display:block;font-size:9px;letter-spacing:1.5px;color:#94a3b8;font-weight:800;margin-bottom:8px}
.stat b{font-size:18px;color:#fff;font-weight:900}
.stat-note{font-size:11px;color:#94a3b8;margin:12px 0 14px;font-family:monospace}
.live-card{display:flex;align-items:center;gap:12px;background:#0f1426;border:1px solid #232a44;border-radius:22px;padding:16px;text-align:left}
.live-icon{width:54px;height:54px;border-radius:16px;background:#1a1f33;border:1px solid #3a3320;display:flex;align-items:center;justify-content:center;color:#fbbf24;font-size:22px;flex-shrink:0}
.live-mid{flex:1;min-width:0}
.live-head{font-size:12px;font-weight:900;color:#fff;letter-spacing:1px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.active-pill{display:inline-flex;align-items:center;gap:5px;background:#0d2a26;border:1px solid #146c57;color:#34d399;font-size:10px;padding:3px 8px;border-radius:10px;letter-spacing:0}
.live-amt{font-size:20px;font-weight:900;color:#fff;margin-top:4px}
.live-amt small{font-size:11px;color:#cbd5e1}
.live-sub{font-size:10px;color:#94a3b8;margin-top:2px}
.btn-collect{width:auto;padding:14px 18px;background:linear-gradient(135deg,#10b981,#059669);color:#fff;border-radius:16px;box-shadow:0 6px 18px rgba(16,185,129,.3)}
.btn-collect.btn-disabled{background:#1b2136;color:#6b7280;box-shadow:none}
.channel-badge{display:flex;flex-direction:column;align-items:center;gap:4px;min-width:64px;padding:12px 8px!important;color:#fff!important;font-size:16px!important}.channel-badge em{font-style:normal;font-size:9px;font-weight:900;letter-spacing:1px;color:#b6f03c}
.lvl-card{background:#0f1426;border:1px solid #232a44;border-radius:20px;padding:16px;text-align:center;margin-bottom:14px}
.lvl-card span{display:block;font-size:11px;letter-spacing:3px;color:#94a3b8;font-weight:800}
.lvl-card b{display:block;font-size:28px;color:#f5a623;font-weight:900;margin:6px 0}
.lvl-card em{font-style:normal;font-size:12px;color:#94a3b8;font-weight:700}
.ref-line{display:flex;justify-content:space-between;align-items:center;font-size:13px;color:#94a3b8;margin-top:14px}
.ref-line b{color:#fff;font-size:14px}
.ref-head,.ref-row{display:grid;grid-template-columns:1.5fr 1fr 1fr 1fr;gap:6px;align-items:center;font-size:11px;padding:10px 8px;text-align:left}
.ref-head{background:#2a2110;border-radius:12px;color:#f5a623;font-weight:900}
.ref-row{border-bottom:1px solid #232a44;color:#cbd5e1;font-weight:700}
.ref-ok{background:#0d2a26;border:1px solid #146c57;color:#34d399;border-radius:10px;padding:4px 6px;text-align:center;font-weight:800}
.ref-empty{text-align:center;color:#94a3b8;font-size:12px;padding:22px 0}
.wd-title{display:flex;align-items:center;gap:10px;font-size:15px;font-weight:900;color:#fff;letter-spacing:.5px;text-align:left;margin:8px 0 14px}
.wd-title i{width:5px;height:26px;background:#f5a623;border-radius:3px;flex-shrink:0}
.wd-card{padding:20px}
.wd-bal{text-align:center;font-size:30px;font-weight:900;color:#fff;margin:10px 0 20px}
.wd-input{position:relative;display:flex;align-items:center;background:#0b0f1d;border:1px solid #232a44;border-radius:16px;margin:8px 0 16px}
.wd-input i{margin-left:14px;color:#f5a623;font-size:18px}
.wd-input i.ok{color:#10d98c}
.wd-input input{flex:1;min-width:0;background:transparent;border:none;outline:none;color:#fff;font-size:14px;font-weight:bold;padding:16px 10px;user-select:text}
.wd-input .max-btn{position:static;margin-right:10px;padding:8px 14px;border-radius:10px}
.wd-row{display:flex;justify-content:space-between;align-items:center}
.wd-min{font-size:11px;color:#94a3b8;font-weight:700}
.wd-head,.wd-r{display:grid;grid-template-columns:1fr 1fr 1.2fr 1fr;gap:6px;align-items:center;font-size:11px;padding:10px 8px;text-align:left}
.wd-head{background:#2a2110;border-radius:12px;color:#f5a623;font-weight:900}
.wd-r{border-bottom:1px solid #232a44;color:#cbd5e1;font-weight:700}
.st-pill{border-radius:10px;padding:4px 6px;text-align:center;font-weight:800;font-size:10px}
.st-pending{background:#2a2110;border:1px solid #7a5a14;color:#fbbf24}
.st-paid{background:#0d2a26;border:1px solid #146c57;color:#34d399}

/* ===== GAME THEME: brown/maroon cards, gold borders, 3D buttons ===== */
:root{--gold:#f5c542;--gold2:#e8a93a;--brown1:#82502a;--brown2:#5d3719;--maroon1:#6e3044;--maroon2:#4a1f2d;--ink:#241408;--edge:#3a210f}
body{background:#070b16}
.app-container{background:linear-gradient(180deg,#0a0f1d 0%,#070b16 100%)}
.btn,.dash-title,.wd-title,.title-header,.bal-amount,.wd-bal,.live-amt,.ticker,.plan-pill,.task-pill{font-family:'Russo One',-apple-system,"Segoe UI",Roboto,sans-serif}

/* cards */
.card,.live-card,.stat,.lvl-card,.history-item,.user-profile-header{background:linear-gradient(180deg,var(--brown1),var(--brown2));border:3px solid var(--gold);border-radius:28px;box-shadow:0 6px 0 var(--edge),0 10px 24px rgba(0,0,0,.5)}
.balance-card,.wd-card{background:linear-gradient(180deg,var(--maroon1),var(--maroon2));border:3px solid var(--gold);border-radius:30px;box-shadow:0 6px 0 var(--edge),0 10px 24px rgba(0,0,0,.5)}
.ticker,.plan-pill{background:#0e1426;border:2px solid var(--gold);color:#ffe9a8;box-shadow:0 4px 0 var(--edge)}
.history-item{border-radius:18px;border-width:2px;box-shadow:none;background:#3a2210}
.user-profile-header{border-radius:24px}
.stat{border-radius:22px;border-width:2px;box-shadow:0 4px 0 var(--edge)}
.live-icon{background:var(--ink);border:2px solid var(--gold)}
.user-details span,.card-label,.stat span,.lvl-card span,.eyebrow,.wd-min,.stat-note,.live-sub,.ref-line,.bal-label{color:#f5c542}
.card-label{letter-spacing:2px;font-weight:900}
.ref-line b,.stat b,.live-head,.dash-title{color:#fff}
.stat-note,.live-sub,.wd-min,.ref-line span{color:#f1d69a}
.earn-pill,.active-pill{background:#17472a;border:2px solid #4fb36e;color:#8cf0a8}
.verify-card{background:linear-gradient(180deg,var(--brown1),var(--brown2))!important;border:3px solid var(--gold)!important;box-shadow:0 6px 0 var(--edge)}
#verification-screen{background:linear-gradient(160deg,#3a1030 0%,#0b1020 50%,#050810 100%)}
.verify-logo-box{border:3px solid var(--gold);box-shadow:0 0 24px rgba(245,197,66,.4)}
.channel-item{background:var(--ink)!important;border:3px solid var(--gold)!important;border-radius:22px;color:#f1d69a}
.channel-badge{background:linear-gradient(180deg,#f8d66a,#e8a93a)!important;color:#3a2208!important;border-radius:14px!important}
.channel-badge em{color:#3a2208}
.channel-details h5{color:#fff;font-family:'Russo One',sans-serif;font-size:15px}
.channel-details span{color:#f1d69a}

/* inputs */
.wd-input,.trx-input-wrapper input,.input-group input{background:var(--ink);border:3px solid var(--gold);border-radius:20px;color:#fff}
.trx-input-wrapper input{padding:14px 64px 14px 14px;font-size:12px}
.wd-input i{color:var(--gold)}

/* 3D buttons */
.btn{border:none;border-radius:22px;text-transform:uppercase;letter-spacing:1px;font-weight:400;font-size:14px;padding:16px 14px;position:relative;transition:transform .08s,box-shadow .08s;box-shadow:0 6px 0 var(--sh,#8a5a12),inset 0 2px 0 rgba(255,255,255,.45)}
.btn:active{transform:translateY(5px);box-shadow:0 1px 0 var(--sh,#8a5a12),inset 0 2px 0 rgba(255,255,255,.3)}
.btn-gold,#verify-btn{--sh:#9a6a17;background:linear-gradient(180deg,#fbe08a,#e8a93a);color:#3a2208;border:none}
#verify-btn{border-radius:22px;padding:18px;font-size:15px;margin-top:16px}
.btn-green{--sh:#1f6b3a;background:linear-gradient(180deg,#7bdc97,#3fa862);color:#fff;text-shadow:0 1px 0 rgba(0,0,0,.3)}
.btn-collect{--sh:#1f6b3a;background:linear-gradient(180deg,#7bdc97,#3fa862);color:#fff;border-radius:20px;padding:15px 16px}
.btn-purple,.btn-dark{--sh:#1c3f9a;background:linear-gradient(180deg,#6fa5f7,#2f64d8);color:#fff;border:none}
.btn-disabled,.btn-collect.btn-disabled{--sh:#241408;background:linear-gradient(180deg,#6a4a2a,#4d3219);color:#b79a6e;box-shadow:0 6px 0 var(--sh);text-shadow:none}
.trx-copy-btn{background:linear-gradient(180deg,#6fa5f7,#2f64d8);border-radius:14px;box-shadow:0 3px 0 #1c3f9a}
.max-btn{background:linear-gradient(180deg,#fbe08a,#e8a93a);color:#3a2208;box-shadow:0 3px 0 #9a6a17;font-family:'Russo One',sans-serif}
.task-pill{background:var(--ink);border:2px solid var(--gold);color:#f1d69a;border-radius:16px;box-shadow:0 4px 0 var(--edge)}
.task-pill.active{background:linear-gradient(180deg,#fbe08a,#e8a93a);color:#3a2208;border-color:var(--gold)}
.lvl-card b{color:#fff}

/* tables */
.ref-head,.wd-head{background:#6b4119;border:2px solid #9a6a2a;color:var(--gold);border-radius:16px}
#ref-list,#withdraw-history-list{background:#3a2210;border:2px solid #9a6a2a;border-radius:18px;margin-top:6px;overflow:hidden}
.ref-row,.wd-r{color:#f6e5bf;border-bottom:1px solid #6b4119}
.ref-empty{color:#d9b97a}
.ref-ok,.st-paid{background:#17472a;border:2px solid #4fb36e;color:#8cf0a8;border-radius:14px}
.st-pending{background:#5a3a12;border:2px solid #c9962b;color:#ffd666;border-radius:14px}

/* bottom nav */
.bottom-nav{background:linear-gradient(180deg,var(--brown1),var(--brown2));border:3px solid var(--gold);border-radius:30px;box-shadow:0 6px 0 var(--edge),0 10px 30px rgba(0,0,0,.7)}
.nav-item{color:#e9c98f;font-family:'Russo One',sans-serif;font-weight:400;font-size:10px}
.nav-item.active{color:#fff}
.nav-item.active i{color:var(--gold)}
.nav-mining-btn{background:linear-gradient(180deg,#fbe08a,#e8a93a);color:#3a2208;border:5px solid var(--edge);box-shadow:0 0 0 3px var(--gold),0 0 22px rgba(245,197,66,.5)}
.nav-item.active .nav-mining-btn{background:linear-gradient(180deg,#fbe08a,#e8a93a);box-shadow:0 0 0 3px var(--gold),0 0 22px rgba(245,197,66,.6)}

/* toast */
#toast-notification{background:#0e1426;border:3px solid var(--gold);color:#fff;font-family:'Russo One',sans-serif}
#toast-notification i{color:#ffd666;background:rgba(245,197,66,.18)}
.title-header i,.wd-title i{color:var(--gold)}
</style>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Russo+One&display=swap">
</head>
<body>

<div id="toast-notification"><i class="fa-solid fa-check"></i><span id="toast-msg">Action successful!</span></div>

<!-- 1. LOADING SPLASH -->
<div id="splash-screen">
    <div class="loader-ring-box">
        <div class="loader-ring"></div>
        <img src="https://cryptologos.cc/logos/shiba-inu-shib-logo.png?v=032" class="loader-logo-img" alt="SHIBA Logo">
    </div>
    <div class="loading-text">LOADING...</div>
</div>

<!-- 2. VERIFICATION (FORCE JOIN) -->
<div id="verification-screen">
    <div class="verify-logo-box">
        <svg viewBox="0 0 100 100" width="70" height="70">
            <polygon points="50,12 88,86 12,86" fill="none" stroke="#39ff14" stroke-width="6" stroke-linejoin="round"/>
            <line x1="30" y1="62" x2="70" y2="62" stroke="#39ff14" stroke-width="6"/>
        </svg>
    </div>
    <div class="verify-card">
        <h3 style="font-size:26px;font-weight:900;color:#fff;margin-bottom:8px;">Verification Required</h3>
        <p style="font-size:14px;color:#a78bfa;margin-bottom:20px;">Must join both channels to continue</p>

        <a href="https://youtube.com/@cryptotech2.1?si=rmjEpw2fe9DEljkk" target="_blank" class="channel-item" onclick="return openChannel(event,this)">
            <div class="channel-info"><span class="channel-badge"><i class="fa-brands fa-youtube"></i><em>YOUTUBE</em></span>
            <div class="channel-details"><h5>Join Channel 1</h5><span>@cryptotech2.1</span></div></div>
            <i class="fa-solid fa-chevron-right"></i>
        </a>
        <a href="https://t.me/updatechanneluta" target="_blank" class="channel-item" onclick="return openChannel(event,this)">
            <div class="channel-info"><span class="channel-badge"><i class="fa-solid fa-link"></i><em>CHANNEL</em></span>
            <div class="channel-details"><h5>Join Channel 2</h5><span>@updatechanneluta</span></div></div>
            <i class="fa-solid fa-chevron-right"></i>
        </a>

        <button class="btn" id="verify-btn" onclick="checkVerification()">I’ve joined — Check again</button>
    </div>
</div>

<div class="app-container">

    <div class="user-profile-header">
        <div class="user-info-left">
            <div class="user-avatar"><i class="fa-solid fa-user"></i></div>
            <div class="user-details">
                <h4 id="user-display-name">Free User</h4>
                <span id="user-id-text">ID: 6663778</span>
            </div>
        </div>
        <div class="bot-brand-right">
            <div class="bot-mini-logo"><img src="https://cryptologos.cc/logos/shiba-inu-shib-logo.png?v=032" alt="Logo"></div>
            <span>AlphaX 🔥</span>
        </div>
    </div>

    <!-- CORE DASHBOARD -->
    <div id="tab-home" class="tab-content active">
                <div class="eyebrow">SHIBA FREE MINER</div>
        <div class="dash-row">
            <div class="dash-title">Dashboard</div>
            <div class="plan-pill"><i class="dot"></i> Active</div>
        </div>

        <div class="balance-card">
            <div class="bal-top"><span class="bal-label">TOTAL BALANCE</span><span class="earn-pill"><i class="dot"></i> Earnings</span></div>
            <div class="bal-amount"><span id="main-balance">0.0000</span> <small>SHIBA</small></div>
            <div class="bal-actions">
                <button class="btn btn-gold" onclick="switchTab('tasks')"><i class="fa-solid fa-gift"></i> Get Free Shiba</button>
                <button class="btn btn-gold" onclick="switchTab('withdraw')"><i class="fa-solid fa-arrow-up-from-bracket"></i> Withdraw</button>
            </div>
        </div>

        <div class="stat-grid">
            <div class="stat"><span>MINING PLAN</span><b>Active</b></div>
            <div class="stat"><span>DAILY REWARD</span><b>1000 <small style="font-size:12px;">SHIBA</small></b></div>
            <div class="stat"><span>STATUS</span><b style="color:#34d399;">Active</b></div>
        </div>
        <div class="stat-note">+1000 SHIBA / day (No Investment Required)</div>

        <div class="live-card">
            <div class="live-icon"><i class="fa-solid fa-hammer"></i></div>
            <div class="live-mid">
                <div class="live-head">LIVE MINING <span class="active-pill"><i class="dot"></i> Active</span></div>
                <div class="live-amt"><span id="live-amount">0.0000</span> <small>SHIBA</small></div>
                <div class="live-sub" id="live-sub">Ready to collect</div>
            </div>
            <button class="btn btn-collect" id="claim-btn" onclick="claimFreeMining()">Collect</button>
        </div>
    </div>

    <!-- TASKS -->
    <div id="tab-tasks" class="tab-content">
        <div class="title-header"><i class="fa-solid fa-clipboard-list" style="color:#f5a623;"></i> Tasks</div>
        <div class="task-pills">
            <div class="task-pill active" id="pill-social" onclick="switchTaskGroup('social')"><i class="fa-solid fa-paper-plane"></i> Social</div>
            <div class="task-pill" id="pill-youtube" onclick="switchTaskGroup('youtube')"><i class="fa-brands fa-youtube"></i> YouTube</div>
        </div>

        <div class="card" id="group-social">
            <div class="history-item" style="margin-top:5px;">
                <div><b>Join Channel 1</b><br><span style="font-size:10px;color:#f5a623;font-weight:bold;">+500 SHIBA</span></div>
                <button class="btn btn-green" id="task1-btn" style="width:auto;padding:8px 18px;font-size:11px;" onclick="handleTask(1,'https://t.me/paymentchanneluta',500)">Start</button>
            </div>
            <div class="history-item" style="margin-top:10px;">
                <div><b>Join Channel 2</b><br><span style="font-size:10px;color:#f5a623;font-weight:bold;">+500 SHIBA</span></div>
                <button class="btn btn-green" id="task2-btn" style="width:auto;padding:8px 18px;font-size:11px;" onclick="handleTask(2,'https://t.me/cryptotech16',500)">Start</button>
            </div>
        </div>

        <div class="card" id="group-youtube" style="display:none;">
            <div class="history-item" style="margin-top:5px;">
                <div><b>Subscribe YouTube Channel</b><br><span style="font-size:10px;color:#f5a623;font-weight:bold;">+500 SHIBA</span></div>
                <button class="btn btn-green" id="task3-btn" style="width:auto;padding:8px 18px;font-size:11px;" onclick="handleTask(3,YOUTUBE_URL,500)">Start</button>
            </div>
        </div>
    </div>

    <!-- REFERRALS -->
    <div id="tab-earn" class="tab-content">
        <div class="title-header"><i class="fa-solid fa-users" style="color:#f5a623;"></i> Referrals</div>
        <p style="font-size:12px;color:#94a3b8;margin:-8px 0 14px;text-align:left;">Invite friends and earn <b style="color:#f5a623;">500 SHIBA</b> instantly for every friend who joins!</p>

        <div class="lvl-card"><span>LEVEL 1</span><b>500 SHIBA</b><em>Direct Friends</em></div>

        <div class="card">
            <span class="card-label">YOUR EXCLUSIVE REFERRAL LINK</span>
            <div class="trx-input-wrapper">
                <input type="text" id="ref-link" readonly>
                <button class="trx-copy-btn" onclick="copyRefLink()"><i class="fa-solid fa-copy"></i></button>
            </div>
            <button class="btn btn-gold" onclick="shareRefLink()" style="margin-top:5px;font-size:15px;letter-spacing:1px;"><i class="fa-solid fa-link"></i> SHARE LINK</button>
            <div class="ref-line"><span>Total Team Members:</span><b id="ref-total">0 Friends</b></div>
            <div class="ref-line"><span>Total Referral Bonus Earned:</span><b id="ref-bonus" style="color:#34d399;">0 SHIBA</b></div>
        </div>

        <div class="card">
            <span class="card-label" style="text-align:center;margin-bottom:12px;">MY REFERRALS TEAM LIST</span>
            <div class="ref-head"><span>User ID</span><span>Joined</span><span>Bonus</span><span>Status</span></div>
            <div id="ref-list"></div>
        </div>
    </div>

    <!-- WALLET -->
    <div id="tab-withdraw" class="tab-content">
        <div class="wd-title"><i></i> WITHDRAW SHIBA TO EXTERNAL WALLET</div>
        <div class="card wd-card">
            <div class="card-label" style="text-align:center;">TOTAL AVAILABLE BALANCE</div>
            <div class="wd-bal"><span id="withdraw-balance">0.0000</span> SHIBA</div>
            <label class="card-label">SHIBA BEP-20 (BSC) ADDRESS</label>
            <div class="wd-input"><i class="fa-solid fa-wallet" id="addr-icon"></i><input type="text" id="withdraw-address" placeholder="0x... wallet address" oninput="checkAddr()"></div>
            <div class="wd-row"><label class="card-label">AMOUNT TO WITHDRAW</label><span class="wd-min">Min: 5000 SHIBA</span></div>
            <div class="wd-input"><i class="fa-solid fa-coins"></i><input type="number" id="withdraw-amount" placeholder="5000" min="5000"><button type="button" class="max-btn" onclick="setMaxWithdraw()">MAX</button></div>
            <button class="btn btn-gold" style="margin-top:6px;font-size:15px;letter-spacing:1px;" onclick="requestWithdraw()">CONFIRM WITHDRAWAL</button>
        </div>
        <div class="card">
            <span class="card-label" style="margin-bottom:12px;"><i class="fa-solid fa-file-invoice" style="color:#f5a623;"></i> MY WITHDRAWAL REQUESTS</span>
            <div class="wd-head"><span>Date</span><span>Wallet</span><span>Amount</span><span>Status</span></div>
            <div id="withdraw-history-list"><div class="ref-empty">No withdrawal requests yet.</div></div>
        </div>
    </div>

    <nav class="bottom-nav">
        <a class="nav-item active" id="nav-home" onclick="switchTab('home')"><i class="fa-solid fa-microchip"></i><span>Core</span></a>
        <a class="nav-item" id="nav-tasks" onclick="switchTab('tasks')"><i class="fa-solid fa-clipboard-list"></i><span>Tasks</span></a>
        <a class="nav-item" id="nav-mining" onclick="claimFreeMining()"><div class="nav-mining-btn"><i class="fa-solid fa-bolt"></i></div><span>Collect</span></a>
        <a class="nav-item" id="nav-earn" onclick="switchTab('earn')"><i class="fa-solid fa-users"></i><span>Referrals</span></a>
        <a class="nav-item" id="nav-withdraw" onclick="switchTab('withdraw')"><i class="fa-solid fa-wallet"></i><span>Wallet</span></a>
    </nav>
</div>

<script>
let tg = window.Telegram?.WebApp;
if (tg && typeof tg.expand === 'function') { tg.expand(); }

let tgUser = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
let userId = tgUser && tgUser.id ? tgUser.id : 6663778;
let username = tgUser && tgUser.first_name ? tgUser.first_name : "Free User";

document.getElementById('user-display-name').innerText = username;
document.getElementById('user-id-text').innerText = `ID: ${userId}`;
document.getElementById('ref-link').value = `https://t.me/AlphaXEarnTg_bot?start=${userId}`;

let storageKey = `alpha_shiba_user_${userId}`;
let savedData;
try { savedData = JSON.parse(localStorage.getItem(storageKey)); } catch (e) { savedData = null; }
savedData = savedData || { balance: 0, isVerified: false, lastClaim: 0, task1: "JOIN", task2: "JOIN", withdrawals: [] };

savedData.joined = savedData.joined || [];
savedData.referrals = savedData.referrals || [];
const REF_BONUS = 500;
savedData.task3 = savedData.task3 || "JOIN";

// ===== SECURITY SETTINGS =====
const BOT_USERNAME = 'AlphaXEarnTg_bot';
// Render server link. Server ka POST /check yahan se chalega.
const API_URL = 'https://bnb-smart-miner.onrender.com';
// TEST_MODE=false: server confirm kiye bina koi aage nahi ja sakta (force join ON)
const TEST_MODE = false;
const YOUTUBE_URL = 'https://youtube.com/@loveallah-r4b?si=a56TmO61cBw8F6tT';

// Server ki channel list ka order (server mein bhi bilkul yahi order hona chahiye):
// 0 = @updatechanneluta (start verification)
// 1 = @paymentchanneluta (Task 1)
// 2 = @cryptotech16 (Task 2)
const CH_VERIFY = [0];
const TASK_CH = { 1: [1], 2: [2] };

let joinedSet = new Set(savedData.joined);
let mainBalance = savedData.balance;
let withdrawHistory = savedData.withdrawals;

function saveData() {
    savedData.balance = mainBalance;
    savedData.withdrawals = withdrawHistory;
    try { localStorage.setItem(storageKey, JSON.stringify(savedData)); } catch (e) {}
}

function renderReferrals() {
    let list = savedData.referrals || [];
    let total = list.reduce((t, r) => t + r.bonus, 0);
    document.getElementById('ref-total').innerText = list.length + (list.length === 1 ? ' Friend' : ' Friends');
    document.getElementById('ref-bonus').innerText = total.toLocaleString() + ' SHIBA';
    let box = document.getElementById('ref-list');
    if (!list.length) { box.innerHTML = '<div class="ref-empty">No referrals yet. Share your link to start earning!</div>'; return; }
    box.innerHTML = list.map(r => `<div class="ref-row"><span>${r.id}</span><span>${r.date}</span><span style="color:#34d399;">+${r.bonus}</span><span class="ref-ok">✓ Active</span></div>`).join('');
}

function addReferral(id) {
    if (savedData.referrals.some(r => String(r.id) === String(id))) return;
    savedData.referrals.unshift({ id: id, date: new Date().toLocaleDateString(), bonus: REF_BONUS });
    mainBalance += REF_BONUS;
    saveData(); updateUI(); renderReferrals();
    showToast(`+${REF_BONUS} SHIBA referral bonus!`);
}

function shareRefLink() {
    let link = document.getElementById('ref-link').value;
    openLink('https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent('Get free SHIBA every day! 🐕'));
}

function showVerify() { document.getElementById('verification-screen').style.display = 'flex'; }

function startApp() {
    renderReferrals();
    updateUI(); updateTaskButtons(); renderHistory(); checkMiningTimer();
    document.querySelectorAll('#verification-screen .channel-item').forEach(el => {
        if (joinedSet.has(el.getAttribute('href'))) {
            let ic = el.querySelector('i.fa-chevron-right');
            if (ic) { ic.className = 'fa-solid fa-circle-check'; ic.style.color = '#f5a623'; }
        }
    });
    let seen = false;
    try { seen = sessionStorage.getItem('alpha_splash_done') === '1'; } catch (e) {}
    let splash = document.getElementById('splash-screen');
    let proceed = () => {
        if (splash) { splash.style.opacity = '0'; setTimeout(() => splash.remove(), 500); }
        // Hamesha pehle verification screen dikhao; server confirm kare tab hi hatao
        if (!savedData.isVerified) { showVerify(); return; }
        // Pehle verify ho chuka hai: phir bhi server se dobara check (channel leave kiya to wapas lock)
        showVerify();
        serverCheck(CH_VERIFY).then(r => {
            if (r.ok) {
                document.getElementById('verification-screen').style.display = 'none';
                switchTab('home');
            } else {
                savedData.isVerified = false; saveData();
                showToast(r.error ? r.error : 'Channel join karo, phir aage jao.');
            }
        });
    };
    if (seen) {
        if (splash) splash.remove();
        proceed();
    } else {
        setTimeout(() => { try { sessionStorage.setItem('alpha_splash_done', '1'); } catch (e) {} proceed(); }, 2500);
    }
}
if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', startApp); } else { startApp(); }

function openLink(url) {
    try {
        if (tg && typeof tg.openTelegramLink === 'function' && url.indexOf('https://t.me/') === 0) { tg.openTelegramLink(url); return; }
    } catch (e) {}
    window.open(url, '_blank');
}
function openChannel(e, el) {
    e.preventDefault();
    openLink(el.getAttribute('href'));
    markJoined(el);
    return false;
}

function markJoined(el) {
    joinedSet.add(el.getAttribute('href'));
    savedData.joined = Array.from(joinedSet); saveData();
    let ic = el.querySelector(':scope > i');
    ic.className = 'fa-solid fa-circle-check';
    ic.style.color = '#f5a623';
}

// Server se check: Telegram channel membership (getChatMember). Server na mile to aage jane nahi dega.
async function serverCheck(only) {
    if (!API_URL) return TEST_MODE ? { ok: true } : { ok: false, error: 'Server connected nahi hai' };
    try {
        let r = await fetch(API_URL + '/check', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ initData: (tg && tg.initData) ? tg.initData : '', only: only })
        });
        return await r.json();
    } catch (e) { return { ok: false, error: 'Network error, dobara try karo' }; }
}

// Dono link kholne zaroori + Telegram channel server se confirm hona zaroori
async function checkVerification() {
    let btn = document.getElementById('verify-btn');
    if (joinedSet.size < 2) { showToast("Pehle dono channels join karo!"); return; }
    btn.innerText = 'Checking...'; btn.disabled = true;
    let r = await serverCheck(CH_VERIFY);
    btn.innerText = 'I\u2019ve joined \u2014 Check again'; btn.disabled = false;
    if (!r.ok) {
        showToast(r.error ? r.error : 'Pehle join karo: ' + (r.missing || []).join(', '));
        return;
    }
    savedData.isVerified = true;
    saveData();
    document.getElementById('verification-screen').style.display = 'none';
    switchTab('home');
    showToast("Verification successful! Welcome to Mining.");
}

function showToast(message) {
    let toast = document.getElementById('toast-notification');
    document.getElementById('toast-msg').innerText = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
}

function copyRefLink() {
    let refInput = document.getElementById('ref-link');
    refInput.select();
    try { navigator.clipboard.writeText(refInput.value); } catch (e) {}
    showToast("Referral link copied!");
}

function updateUI() {
    document.getElementById('main-balance').innerText = mainBalance.toFixed(4);
    document.getElementById('withdraw-balance').innerText = mainBalance.toFixed(4);
}

function setMaxWithdraw() { document.getElementById('withdraw-amount').value = mainBalance.toFixed(4); }

async function claimFreeMining() {
    if (!savedData.isVerified) { showVerify(); return; }
    let now = Date.now(), cooldown = 24 * 60 * 60 * 1000;
    if (now - savedData.lastClaim < cooldown) {
        let hoursLeft = Math.ceil((cooldown - (now - savedData.lastClaim)) / 3600000);
        showToast(`Next claim in ${hoursLeft} hours!`);
        return;
    }
    // Collect se pehle bhi channel join confirm
    let r = await serverCheck(CH_VERIFY);
    if (!r.ok) {
        savedData.isVerified = false; saveData(); showVerify();
        showToast(r.error ? r.error : 'Pehle channel join karo!');
        return;
    }
    mainBalance += 1000;
    savedData.lastClaim = now;
    saveData(); updateUI(); checkMiningTimer();
    showToast("+1000 SHIBA claimed!");
}

function checkMiningTimer() {
    let cooldown = 24 * 60 * 60 * 1000;
    let elapsed = Date.now() - savedData.lastClaim;
    let btn = document.getElementById('claim-btn');
    let amt = document.getElementById('live-amount');
    let sub = document.getElementById('live-sub');
    if (!btn) return;
    if (elapsed >= cooldown) {
        amt.innerText = '1000.0000';
        sub.innerText = 'Ready to collect';
        btn.innerText = 'Collect'; btn.className = 'btn btn-collect';
    } else {
        amt.innerText = (1000 * elapsed / cooldown).toFixed(4);
        let left = cooldown - elapsed;
        let h = String(Math.floor(left / 3600000)).padStart(2, '0');
        let m = String(Math.floor(left % 3600000 / 60000)).padStart(2, '0');
        let sec = String(Math.floor(left % 60000 / 1000)).padStart(2, '0');
        sub.innerText = `Next collect in ${h}:${m}:${sec}`;
        btn.innerText = 'Mining'; btn.className = 'btn btn-collect btn-disabled';
    }
}
setInterval(checkMiningTimer, 1000);

function updateTaskButtons() {
    [1, 2, 3].forEach(i => {
        let b = document.getElementById(`task${i}-btn`), s = savedData[`task${i}`];
        if (s === "CHECK") { b.innerText = "Check"; b.className = "btn btn-dark"; }
        else if (s === "CLAIMD") { b.innerText = "Claimed"; b.className = "btn btn-disabled"; }
    });
}

function switchTaskGroup(g) {
    ['social','youtube'].forEach(n => {
        document.getElementById('group-' + n).style.display = (n === g) ? 'block' : 'none';
        document.getElementById('pill-' + n).classList.toggle('active', n === g);
    });
}

async function handleTask(id, link, reward) {
    if (!savedData.isVerified) { showVerify(); return; }
    let key = `task${id}`;
    if (savedData[key] === "JOIN") {
        openLink(link);
        savedData[key] = "CHECK";
        saveData(); updateTaskButtons();
    } else if (savedData[key] === "CHECK") {
        // Telegram tasks (1,2): jab tak server join confirm na kare, reward nahi milega
        if (TASK_CH[id]) {
            let r = await serverCheck(TASK_CH[id]);
            if (!r.ok) { showToast(r.error ? r.error : 'Pehle channel join karo!'); return; }
        }
        savedData[key] = "CLAIMD";
        mainBalance += reward;
        saveData(); updateTaskButtons(); updateUI();
        showToast(`+${reward} SHIBA claimed!`);
    }
}

function renderHistory() {
    let box = document.getElementById('withdraw-history-list');
    if (!withdrawHistory || !withdrawHistory.length) { box.innerHTML = '<div class="ref-empty">No withdrawal requests yet.</div>'; return; }
    box.innerHTML = withdrawHistory.map(item => {
        let st = String(item.status).toUpperCase();
        let cls = st === 'PAID' ? 'st-paid' : 'st-pending';
        let w = item.address ? item.address.slice(0, 6) + '...' : '-';
        let d = String(item.date).split(' ')[0];
        return `<div class="wd-r"><span>${d}</span><span>${w}</span><span>-${item.amount}</span><span class="st-pill ${cls}">${st === 'PAID' ? '✓ PAID' : 'PENDING'}</span></div>`;
    }).join('');
}

function checkAddr() {
    let v = document.getElementById('withdraw-address').value.trim();
    let ic = document.getElementById('addr-icon');
    let ok = /^0x[a-fA-F0-9]{40}$/.test(v);
    ic.className = ok ? 'fa-solid fa-circle-check ok' : 'fa-solid fa-wallet';
}

function switchTab(tabName) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.getElementById(`tab-${tabName}`).classList.add('active');
    document.getElementById(`nav-${tabName}`).classList.add('active');
}

function requestWithdraw() {
    if (!savedData.isVerified) { showVerify(); return; }
    let addr = document.getElementById('withdraw-address').value.trim();
    let amt = parseFloat(document.getElementById('withdraw-amount').value);
    if (!addr || !amt) { showToast("Please fill all fields!"); return; }
    if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) { showToast("Invalid BEP-20 wallet address!"); return; }
    if (amt < 5000) { showToast("Minimum withdrawal is 5000 SHIBA!"); return; }
    if (amt > mainBalance) { showToast("Insufficient balance!"); return; }
    mainBalance -= amt;
    let now = new Date().toLocaleDateString() + ' ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    withdrawHistory.unshift({ amount: amt, address: addr, date: now, status: 'PENDING' });
    saveData(); updateUI(); renderHistory();
    showToast("Withdrawal request submitted!");
    document.getElementById('withdraw-amount').value = '';
    document.getElementById('withdraw-address').value = '';
    checkAddr();
}
</script>
</body>
</html>
