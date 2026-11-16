// jarvis-input: posts mouse and keyboard events through Quartz (CoreGraphics).
// Long-running; server/input.js spawns it and writes one command per line on stdin.
// Coordinates are global display points (origin top-left of the main display).
//
//   move x y            move (drags if the button is down)
//   down x y | up x y   left button (`up` alone releases where the cursor is)
//   click x y           press + release; a second click close in time and place is a double click
//   scroll dx dy        wheel pixels; dy > 0 scrolls toward the top, dx > 0 toward the left
//   key code flags      press + release one key (virtual key code, CGEventFlags as a number)
//   status              prints: status <originX> <originY> <width> <height> <trusted 0|1>
//   front               prints: front <pid>\t<bundleId>\t<name>
//
// It also prints a `front` line by itself whenever another app comes to the front.
//
// Posting events needs Accessibility permission for the app that started the
// helper (Terminal, iTerm, VS Code). Without it macOS drops the events silently;
// `status` reports trusted 0 in that case.
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)
func out(_ s: String) { print(s); fflush(stdout) }

let source = CGEventSource(stateID: .hidSystemState)
var buttonDown = false
var lastClick = (t: 0.0, x: 0.0, y: 0.0, count: 0)
let DOUBLE_CLICK_SLOP = 6.0 // points

func post(_ e: CGEvent?) { e?.post(tap: .cghidEventTap) }

func mouse(_ type: CGEventType, _ x: Double, _ y: Double, clicks: Int64 = 1) {
  let e = CGEvent(mouseEventSource: source, mouseType: type,
                  mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)
  e?.setIntegerValueField(.mouseEventClickState, value: clicks)
  post(e)
}

func key(_ code: Int, _ flags: UInt64) {
  for down in [true, false] {
    let e = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(code), keyDown: down)
    e?.flags = CGEventFlags(rawValue: flags)
    post(e)
  }
}

// ── frontmost app ──
var lastFront = ""
func frontLine(_ app: NSRunningApplication?) -> String {
  guard let a = app else { return "front 0\t\t" }
  let name = (a.localizedName ?? "").replacingOccurrences(of: "\t", with: " ")
  return "front \(a.processIdentifier)\t\(a.bundleIdentifier ?? "")\t\(name)"
}
/// The owner of the topmost normal window. Works in a command line tool even when
/// NSWorkspace's frontmostApplication is not being refreshed.
func frontFromWindows() -> NSRunningApplication? {
  let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { return nil }
  for w in list where (w[kCGWindowLayer as String] as? Int) == 0 {
    if let pid = w[kCGWindowOwnerPID as String] as? Int32 { return NSRunningApplication(processIdentifier: pid) }
  }
  return nil
}
func reportFront(_ app: NSRunningApplication?, force: Bool = false) {
  let line = frontLine(app)
  if force || line != lastFront { lastFront = line; out(line) }
}
NSWorkspace.shared.notificationCenter.addObserver(
  forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
) { note in
  reportFront(note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)
}
// Backup in case activation notifications are missed (no app bundle, no NSApplication).
let FRONT_POLL_S = 0.5
Timer.scheduledTimer(withTimeInterval: FRONT_POLL_S, repeats: true) { _ in
  reportFront(NSWorkspace.shared.frontmostApplication ?? frontFromWindows())
}

func status() {
  let b = CGDisplayBounds(CGMainDisplayID())
  out("status \(Int(b.origin.x)) \(Int(b.origin.y)) \(Int(b.width)) \(Int(b.height)) \(AXIsProcessTrusted() ? 1 : 0)")
}

func handle(_ line: String) {
  let p = line.split(separator: " ").map(String.init)
  guard let cmd = p.first else { return }
  func num(_ i: Int) -> Double { i < p.count ? (Double(p[i]) ?? 0) : 0 }
  switch cmd {
  case "move":
    mouse(buttonDown ? .leftMouseDragged : .mouseMoved, num(1), num(2))
  case "down":
    buttonDown = true
    mouse(.leftMouseDown, num(1), num(2))
  case "up":
    buttonDown = false
    let at = p.count >= 3 ? CGPoint(x: num(1), y: num(2)) : (CGEvent(source: nil)?.location ?? .zero)
    mouse(.leftMouseUp, at.x, at.y)
  case "click":
    let now = ProcessInfo.processInfo.systemUptime
    let x = num(1), y = num(2)
    var count = 1
    if now - lastClick.t < NSEvent.doubleClickInterval,
       abs(x - lastClick.x) < DOUBLE_CLICK_SLOP, abs(y - lastClick.y) < DOUBLE_CLICK_SLOP {
      count = lastClick.count + 1
    }
    lastClick = (now, x, y, count)
    mouse(.mouseMoved, x, y)
    mouse(.leftMouseDown, x, y, clicks: Int64(count))
    mouse(.leftMouseUp, x, y, clicks: Int64(count))
  case "scroll":
    post(CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2,
                 wheel1: Int32(num(2).rounded()), wheel2: Int32(num(1).rounded()), wheel3: 0))
  case "key":
    key(Int(num(1)), UInt64(num(2)))
  case "front":
    reportFront(NSWorkspace.shared.frontmostApplication ?? frontFromWindows(), force: true)
  case "status":
    status()
  default:
    out("error unknown command \(cmd)")
  }
}

DispatchQueue.global(qos: .userInteractive).async {
  while let line = readLine() {
    DispatchQueue.main.async { handle(line) }
  }
  // stdin closed: the server went away. Never leave the button held.
  DispatchQueue.main.async {
    if buttonDown {
      let at = CGEvent(source: nil)?.location ?? .zero // top-left origin, unlike NSEvent.mouseLocation
      mouse(.leftMouseUp, at.x, at.y)
    }
    exit(0)
  }
}
status()
reportFront(NSWorkspace.shared.frontmostApplication ?? frontFromWindows(), force: true)
RunLoop.main.run()
