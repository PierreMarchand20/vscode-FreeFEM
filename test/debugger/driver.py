"""Plays the debug adapter's role over the Unix socket protocol (see ../README.md).
Used by suite.py; FF_BIN overrides the interpreter under test."""
import os, shutil, socket, subprocess, sys, tempfile, time
SCR = os.path.dirname(os.path.abspath(__file__))
BIN = os.environ.get("FF_BIN") or shutil.which("FreeFem++") or "FreeFem++"
SCRIPT = os.path.join(SCR, "dbgtest.edp")
SOCK = os.path.join(tempfile.gettempdir(), "ffdbg-test-%d.sock" % os.getpid())

def esc(s): return s.replace("\\","\\\\").replace("\n","\\n").replace("\t","\\t").replace("\r","\\r")
def unesc(s):
    out=[];i=0
    while i<len(s):
        if s[i]=="\\" and i+1<len(s):
            i+=1; out.append({"n":"\n","t":"\t","r":"\r"}.get(s[i],s[i]))
        else: out.append(s[i])
        i+=1
    return "".join(out)

class Session:
    def __init__(self, script=SCRIPT, extra_env=None):
        if os.path.exists(SOCK): os.unlink(SOCK)
        self.srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.srv.bind(SOCK); self.srv.listen(1); self.srv.settimeout(30)
        env = dict(os.environ, FF_DEBUG_SOCKET=SOCK)
        self.log = open(os.path.join(tempfile.gettempdir(),"ffdbg-child.log"),"w")
        self.p = subprocess.Popen([BIN, script, "-nw", "-cd"], cwd=os.path.dirname(script), env=env,
                                  stdout=self.log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
        self.conn, _ = self.srv.accept(); self.conn.settimeout(30)
        self.f = self.conn.makefile("r", newline="\n")
    def send(self, *fields):
        self.conn.sendall(("\t".join(fields)+"\n").encode())
    def recv(self):
        l = self.f.readline()
        if not l: return None
        return l.rstrip("\n").split("\t")
    def until_end(self):
        rows=[]
        while True:
            m=self.recv()
            assert m is not None, "socket closed mid-response"
            if m==["end"]: return rows
            rows.append(m)
    def close(self):
        try: self.conn.close()
        except: pass
        try: self.p.wait(timeout=10)
        except subprocess.TimeoutExpired: self.p.kill(); self.p.wait()
        self.log.close(); self.srv.close()
        if os.path.exists(SOCK): os.unlink(SOCK)

fails=[]
def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ")+name+("" if cond else "  -> "+str(detail)))
    if not cond: fails.append(name)

def covers(msg, line): return int(msg[3])<=line<=int(msg[4])
