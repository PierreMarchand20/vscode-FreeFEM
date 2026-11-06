#!/usr/bin/env python3
# Protocol conformance suite for the interpreter's debug channel.
# Run: python3 test/debugger/suite.py   (FreeFem++ built with the debugger support on PATH, or FF_BIN=/path/to/FreeFem++)
import os, signal, subprocess, sys, time
import driver
from driver import Session, esc, unesc, check, covers, SCRIPT, SCR, fails
LOOP = os.path.join(SCR,"loop.edp")
def start(script=SCRIPT): s=Session(script); s.recv(); s.recv(); return s
def line_range(m): return (int(m[3]),int(m[4]))

# ---- 1. entry / hello / exact statement ranges ----
s=Session()
m=s.recv(); check("hello", m[:2]==["hello","1"] and m[2].isdigit(), m)
m=s.recv(); check("entry stop on line 1", m[:2]==["stopped","entry"] and line_range(m)==(1,1), m)
# ---- 2. breakpoints: exact line, gap line, func header (gap) ----
s.send("setbreaks", esc(SCRIPT), "3"); s.send("go")
m=s.recv(); check("bp line 3 -> statement 3..3", m[1]=="breakpoint" and line_range(m)==(3,3), m)
s.send("vars"); d={r[1]:(r[2],r[3]) for r in s.until_end() if r[0]=="var"}
check("var types friendly", d["n"][0]=="int" and d["a"][0]=="real", d)
check("var values live", d["n"][1]=="3" and d["a"][1]=="1.5", d)
s.send("setbreaks", esc(SCRIPT), "5"); s.send("go")   # line 5 = '{' of func body: a gap before 'real c = sq(b)'
m=s.recv(); check("bp on func-body line moves to next statement (line 9)", m[1]=="breakpoint" and line_range(m)==(9,9), m)
# ---- 3. eval, then continue (the cout/cerr alias crash) ----
s.send("eval", esc('cout << "A=" << n*2 << endl;')); r=s.until_end()[0]
check("eval ok", r[1]=="0" and unesc(r[2]).strip()=="A=6", r)
s.send("eval", esc('cout << nosuch << endl;')); r=s.until_end()[0]
check("eval error -> rc!=0 and message", r[1]!="0" and "nosuch" in unesc(r[2]), r)
s.send("eval", esc('real tmp = a*10; cout << tmp << endl;')); r=s.until_end()[0]
check("eval can declare a temporary", r[1]=="0" and unesc(r[2]).strip()=="15", r)
s.send("vars"); d2={r[1] for r in s.until_end() if r[0]=="var"}
check("temporary does not leak into script scope", "tmp" not in d2, d2)
# ---- 4. next over the call keeps script level; for-statement range ----
s.send("setbreaks", esc(SCRIPT), ""); s.send("next")
m=s.recv(); check("next from 9 -> for statement starting at line 10", m[1]=="step" and int(m[3])==10 and int(m[4])>=12, m)
s.send("stack"); rows=s.until_end(); check("still 1 frame after next", len(rows)==1, rows)
s.send("next"); m=s.recv(); check("next enters loop body at its own line (12)", line_range(m)==(12,12), m)
# ---- 4b. multi-line statements, if/else, last statement of a block, for dedupe ----
S2=os.path.join(SCR,"dbgtest2.edp")
t=start(S2); t.send("stepin"); m=t.recv()
check("if/else reports its own first line (2)", int(m[3])==2, m)
t.send("stepin"); m=t.recv(); check("then-branch statement is line 4", line_range(m)==(4,4), m)
t.send("stepin"); m=t.recv(); check("multi-line 'real y =' spans 10..12", line_range(m)==(10,12), m)
t.send("stepin"); m=t.recv(); check("for statement starts at 13", int(m[3])==13, m)
t.send("stepin"); m=t.recv(); check("for is reported once (next stop is the body, line 15)", line_range(m)==(15,15), m)
t.send("stepin"); m=t.recv(); check("loop body LAST statement is its own line 16", line_range(m)==(16,16), m)
t.send("stepin"); m=t.recv(); check("2nd iteration restarts at line 15", line_range(m)==(15,15), m)
t.send("go"); t.recv(); t.close()
# bp on the for header from a fresh run
t=start(S2); t.send("setbreaks", esc(S2), "13"); t.send("go"); m=t.recv()
check("bp on for header (line 13) -> one stop at the for", m[1]=="breakpoint" and int(m[3])==13, m)
t.send("go"); m=t.recv(); check("no second stop for the same for", m==["exited"], m); t.close()
# ---- 4b2. a breakpoint INSIDE a compound statement fires at the inner statement only ----
t=start(S2); t.send("setbreaks", esc(S2), "16"); t.send("go"); m=t.recv()
check("bp on a loop-body line: first stop is that statement (16), not the for (13..16)", m[1]=="breakpoint" and line_range(m)==(16,16), m)
t.send("go"); m=t.recv(); check("...then once per iteration (2nd iteration, line 16)", m[1]=="breakpoint" and line_range(m)==(16,16), m)
t.send("go"); m=t.recv(); check("...and no third stop", m==["exited"], m); t.close()
# ---- 4c. a failed eval must not poison the next one ----
t=start(); t.send("eval", esc('cout << nosuch << endl;')); r=t.until_end()[0]
t.send("eval", esc('cout << n+1 << endl;')); r2=t.until_end()[0]
check("eval after a failed eval is clean", r2[1]=="0" and unesc(r2[2]).strip()=="1", r2)
t.send("go"); t.recv(); t.close()
# ---- 5. step into the function from line 9 ----
s.send("setbreaks", esc(SCRIPT), "9"); s.send("stepout")   # stepout at depth 0 == continue to bp
# (loop already past line 9, so run to end instead)
s.send("setbreaks", esc(SCRIPT), ""); s.send("go")
m=s.recv(); check("exited sent at end", m==["exited"], m)
rc=s.p.wait(timeout=10); check("process exits 0 after evals", rc==0, rc)
s.close()
out=open(os.path.join(__import__("tempfile").gettempdir(),"ffdbg-child.log")).read()
check("script's real output printed (not only echoed)", "\ndone a=4.5 c=9" in out, out[-200:])

# ---- 6. stepping into / out of a function with frames ----
s=start(); s.send("setbreaks", esc(SCRIPT), "9"); s.send("go"); s.recv()
s.send("setbreaks", esc(SCRIPT), ""); s.send("stepin"); m=s.recv()
check("stepin from call line enters sq body (line 6)", line_range(m)==(6,6), m)
s.send("stack"); rows=s.until_end()
check("frames: sq over script, caller line 9", [r[2] for r in rows]==["sq","(script)"] and rows[1][4]=="9" and rows[1][5]=="9", rows)
s.send("stepout"); m=s.recv(); s.send("stack"); rows=s.until_end()
check("stepout lands back in script", len(rows)==1 and m[1]=="step", (m,rows))
s.send("go"); s.recv(); s.close()

# ---- 7. async pause while a long loop runs, then breakpoint toggled live, then quit ----
s=start(LOOP); s.send("go"); time.sleep(0.5)
s.send("pause"); m=s.recv(); check("async pause stops the running loop", m[1]=="pause" and 3<=int(m[3])<=4, m)
s.send("vars"); d={r[1]:r[3] for r in s.until_end() if r[0]=="var"}
check("loop variable s advanced", float(d["s"])>0, d)
s.send("quit"); rc=s.p.wait(timeout=10); check("quit ends the process", rc!=None, rc); s.close()

# ---- 8. cost of the hook: same loop, plain vs debug-active-no-breakpoints ----
def timed(debug):
    env=dict(os.environ); env.pop("FF_DEBUG_SOCKET",None)
    t=time.time()
    if debug:
        s=start(LOOP); s.send("go"); m=s.recv(); dt=time.time()-t; s.close(); return dt, m
    p=subprocess.run([driver.BIN,LOOP,"-nw","-cd"],cwd=SCR,env=env,capture_output=True); return time.time()-t, p.returncode
tp,_=timed(False); td,m=timed(True)
print("   loop of 3M statements: plain %.2fs, debug(no bp) %.2fs  (%s)"%(tp,td,m))
check("debug-mode loop still finishes", m==["exited"], m)


# ---- 9. statements from an included file carry their own file and lines ----
MAIN=os.path.join(SCR,"inctest_main.edp"); INC=os.path.join(SCR,"inctest_inc.edp")
t=start(MAIN)
t.send("setbreaks", esc(INC), "2"); t.send("go"); m=t.recv()
check("breakpoint inside an included file stops there", m[1]=="breakpoint" and os.path.samefile(m[2],INC) and line_range(m)==(2,2), m)
t.send("stack"); rows=t.until_end()
check("frame reports the included file", os.path.samefile(rows[0][3],INC), rows)
t.send("setbreaks", esc(INC), ""); t.send("stepin"); m=t.recv()
check("step continues in the included file (line 3)", os.path.samefile(m[2],INC) and line_range(m)==(3,3), m)
t.send("stepin"); m=t.recv()
check("step returns to the including file (line 3)", os.path.samefile(m[2],MAIN) and line_range(m)==(3,3), m)
t.send("go"); t.recv(); t.close()

print("\nRESULT:", "ALL PASSED" if not fails else "FAILED: %s"%fails)
sys.exit(1 if fails else 0)
