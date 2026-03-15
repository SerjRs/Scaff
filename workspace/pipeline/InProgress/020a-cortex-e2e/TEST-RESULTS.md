# Hippocampus E2E Test Results
Generated: 2026-03-15T13:28:09.308Z

## Summary
- Total: 17
- Passed: 17
- Failed: 0
- Duration: 8.2s

## A — Message Flow

### A1. single webchat → reply ✅
**Expected:** 1 reply on webchat
**Result:** sent=1, channel=webchat

### A2. sequential messages FIFO ✅
**Expected:** 3 replies in order
**Result:** sent=3, order=reply-1,reply-2,reply-3

### A3. session history storage ✅
**Expected:** user + assistant in session
**Result:** users=1, assistants=1

### A4. processedCount increments ✅
**Expected:** processedCount=2, pending=0
**Result:** processed=2, pending=0

### A5. LLM sees message in context ✅
**Expected:** context has webchat foreground + message
**Result:** channel=webchat, msgFound=true

## B — Silent Responses

### B1. NO_REPLY suppresses output ✅
**Expected:** 0 sent, 1 processed
**Result:** sent=0, processed=1

### B2. HEARTBEAT_OK suppresses output ✅
**Expected:** 0 sent, 1 processed
**Result:** sent=0, processed=1

### B3. silence stored as [silence] ✅
**Expected:** [silence] in session as assistant
**Result:** found=true, role=assistant

### B4. mixed silence + responses ✅
**Expected:** 2 real, 2 silent, 4 processed
**Result:** sent=2, processed=4

## K — Webchat-Specific

### K1. WebchatAdapter.toEnvelope ✅
**Expected:** webchat envelope with urgent priority
**Result:** channel=webchat, priority=urgent, sender=serj

### K2. WebchatAdapter captures output ✅
**Expected:** adapter captured 1 message
**Result:** sent=1, content=captured!

### K3. webchat = urgent priority ✅
**Expected:** priority=urgent
**Result:** priority=urgent

### K4. reply routes to source channel ✅
**Expected:** webchat=1, whatsapp=0
**Result:** webchat=1, whatsapp=0

### K5. unified session across channels ✅
**Expected:** 2 user msgs, both channels in session
**Result:** users=2, channels=webchat,whatsapp

### K6. cross-channel send_to directive ✅
**Expected:** whatsapp=1, webchat=0
**Result:** whatsapp=1, webchat=0

### K7. onMessageComplete fires ✅
**Expected:** 2 completions, none silent
**Result:** completions=2, allNotSilent=true

### K8. onMessageComplete silent flag ✅
**Expected:** 1 completion, silent=true
**Result:** completions=1, silent=true

