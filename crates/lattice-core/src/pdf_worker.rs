//! PDFs are read in a worker: this program started again, under a memory and a time limit. lopdf and pdf-extract do
//! whatever a PDF asks: a flate stream inflates without bound, pdf-extract copies its colour state, profile and all, on
//! every `q`, and reads a content, and each font a page uses, again for every page that draws it. In the app that ends
//! it or stalls it, and an ingest job brings the same PDF back after every start. In a worker a limit costs only the
//! PDF: it fails with an error or, when lopdf meets the memory limit as it inflates an object stream, reads without the
//! rest of that stream. A crash that the guards in `pdf` miss fails the PDF the same way.
//!
//! A binary calls `init` before anything else: the app, and `lattice-cli` for its commands, its MCP server and `serve`.
//! A process that does not (a test run) reads PDFs itself, and so does the worker.

use std::ffi::OsString;
use std::io::{self, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::OnceLock;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::msg;

/// Set in a worker's environment.
const WORKER: &str = "LATTICE_PDF_WORKER";

/// What a worker writes before its replies. What the program printed before it is passed over: a test run prints a line
/// or two of its own.
const MARKER: &[u8] = b"\0lattice pdf worker\0";

/// How much a worker may commit. A 6.7 MB book from a real library peaked at 300 MiB, and 1,500 pages of dense text (8
/// million characters) at 1 GiB.
const MEMORY: usize = 2 << 30;

/// How long a worker may take over one reply. A debug build took 3 minutes over that book, and 2 over the 1,500 pages; a
/// release build is faster.
const TIME: Duration = Duration::from_secs(if cfg!(debug_assertions) {
    20 * 60
} else {
    5 * 60
});

/// The largest reply this process takes in. A figure has at most 64 MiB of rows (`MAX_ROWS_BYTES`), and a worker reads a
/// character of text for about 130 bytes of memory, so it has room for some 16 million: an article of 100 MiB or so in
/// JSON.
const REPLY: usize = 256 << 20;

/// A program that reads PDFs when started with `WORKER` set.
pub(crate) struct Worker {
    program: PathBuf,
    args: Vec<OsString>,
    memory: usize,
    time: Duration,
}

/// This program, once `init` has found that it starts workers.
static THIS: OnceLock<Worker> = OnceLock::new();

/// In a worker, answers the request on stdin and exits. Otherwise PDFs are read in workers from now on.
pub fn init() {
    if std::env::var_os(WORKER).is_some() {
        std::process::exit(i32::from(serve().is_err()));
    }
    match std::env::current_exe() {
        Ok(program) => {
            let _ = THIS.set(Worker { program, args: Vec::new(), memory: MEMORY, time: TIME });
        }
        Err(e) => log::warn!("PDFs are read in this process: {e}"),
    }
}

#[derive(Serialize, Deserialize)]
pub(crate) enum Request {
    /// `pdf::to_ir`.
    Ir { fallback: Option<String> },
    /// `pdf::regions`.
    Regions,
    /// `pdf::Figures`: after the PDF, each `src` the worker is sent gets the figure's bytes, or nothing.
    Figures,
}

/// `request` about `pdf`, answered in a worker, or by `here` when this process starts none.
pub(crate) fn ask<T: DeserializeOwned>(request: Request, pdf: &[u8], here: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    match THIS.get() {
        Some(worker) => worker.ask(&request, pdf),
        None => here(),
    }
}

/// The worker this process starts, if it starts them.
pub(crate) fn this() -> Option<&'static Worker> {
    THIS.get()
}

impl Worker {
    pub(crate) fn ask<T: DeserializeOwned>(&self, request: &Request, pdf: &[u8]) -> Result<T, String> {
        self.start(request, pdf)?.reply::<Result<T, String>>()?
    }

    /// A worker that has been sent `request` and `pdf`.
    pub(crate) fn start(&self, request: &Request, pdf: &[u8]) -> Result<Session, String> {
        let mut command = Command::new(&self.program);
        command.args(&self.args).env(WORKER, "1").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)]
        std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000); // CREATE_NO_WINDOW
        let mut child = command.spawn().map_err(|e| {
            log::warn!("starting a PDF worker: {e}");
            msg!("pdf.parseFailed")
        })?;
        // Before the request: until it has one, the worker only waits.
        #[cfg(windows)]
        let job = job::limit(&child, self.memory);
        let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            let _ = child.kill();
            return Err(msg!("pdf.parseFailed"));
        };
        let mut session = Session {
            child,
            stdin,
            replies: replies(stdout),
            time: self.time,
            #[cfg(windows)]
            _job: job,
        };
        session.send(&serde_json::to_vec(request).map_err(|_| msg!("pdf.parseFailed"))?)?;
        session.send(pdf)?;
        Ok(session)
    }
}

/// A worker that has been sent a request. Ended when dropped.
pub(crate) struct Session {
    child: Child,
    stdin: ChildStdin,
    replies: Receiver<Vec<u8>>,
    time: Duration,
    #[cfg(windows)]
    _job: Option<job::Job>,
}

impl Session {
    pub(crate) fn send(&mut self, frame: &[u8]) -> Result<(), String> {
        write_frame(&mut self.stdin, frame).map_err(|_| msg!("pdf.parseFailed"))
    }

    /// The worker's next frame. One that comes too late ends the worker.
    pub(crate) fn frame(&mut self) -> Result<Vec<u8>, String> {
        match self.replies.recv_timeout(self.time) {
            Ok(frame) => Ok(frame),
            Err(RecvTimeoutError::Timeout) => {
                let _ = self.child.kill();
                // A reply that came meanwhile is for this question; the next one would take it as its own.
                self.replies = mpsc::channel().1;
                Err(msg!("pdf.tooSlow", minutes = self.time.as_secs().div_ceil(60)))
            }
            // Ended by its memory limit, by a crash, or by an earlier `frame`.
            Err(RecvTimeoutError::Disconnected) => Err(msg!("pdf.parseFailed")),
        }
    }

    /// The worker's next frame, read as JSON.
    pub(crate) fn reply<T: DeserializeOwned>(&mut self) -> Result<T, String> {
        serde_json::from_slice(&self.frame()?).map_err(|_| msg!("pdf.parseFailed"))
    }

    /// The most memory the worker has committed. Fails when it has no limit.
    #[cfg(all(test, windows))]
    fn peak(&self) -> usize {
        self._job.as_ref().expect("a job object").peak()
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The frames the worker writes, none larger than `REPLY`, until it ends or writes something else.
fn replies(stdout: ChildStdout) -> Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut out = BufReader::new(stdout);
        if skip_to_marker(&mut out).is_err() {
            return;
        }
        while let Ok(frame) = read_frame(&mut out, REPLY) {
            if tx.send(frame).is_err() {
                return;
            }
        }
    });
    rx
}

fn skip_to_marker(out: &mut impl Read) -> io::Result<()> {
    let (mut matched, mut byte) = (0, [0]);
    for _ in 0..64 << 10 {
        out.read_exact(&mut byte)?;
        matched = if byte[0] == MARKER[matched] {
            matched + 1
        } else {
            usize::from(byte[0] == MARKER[0])
        };
        if matched == MARKER.len() {
            return Ok(());
        }
    }
    Err(io::ErrorKind::InvalidData.into())
}

/// A frame: its length as 8 bytes, little-endian, then its bytes.
fn write_frame(to: &mut impl Write, frame: &[u8]) -> io::Result<()> {
    to.write_all(&(frame.len() as u64).to_le_bytes())?;
    to.write_all(frame)?;
    to.flush()
}

fn read_frame(from: &mut impl Read, max: usize) -> io::Result<Vec<u8>> {
    let mut len = [0; 8];
    from.read_exact(&mut len)?;
    let len = usize::try_from(u64::from_le_bytes(len)).ok().filter(|&len| len <= max).ok_or(io::ErrorKind::InvalidData)?;
    // Grown as the bytes come, not by what the length says.
    let mut frame = Vec::new();
    from.take(len as u64).read_to_end(&mut frame)?;
    if frame.len() < len {
        return Err(io::ErrorKind::UnexpectedEof.into());
    }
    Ok(frame)
}

/// The worker's side: reads the PDF here, since a worker starts no workers.
fn serve() -> io::Result<()> {
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    output.write_all(MARKER)?;
    output.flush()?;
    let request: Request = serde_json::from_slice(&read_frame(&mut input, usize::MAX)?)?;
    let pdf = read_frame(&mut input, usize::MAX)?;
    match request {
        Request::Ir { fallback } => write_reply(&mut output, &crate::pdf::to_ir(&pdf, fallback.as_deref())),
        Request::Regions => write_reply(&mut output, &crate::pdf::regions(&pdf)),
        Request::Figures => {
            let figures = crate::pdf::Figures::parse(&pdf).map_err(io::Error::other)?;
            while let Ok(src) = read_frame(&mut input, usize::MAX) {
                let (_, bytes) = figures.image(&String::from_utf8_lossy(&src)).ok().flatten().unwrap_or_default();
                write_frame(&mut output, &bytes)?;
            }
            Ok(())
        }
    }
}

fn write_reply(output: &mut impl Write, value: &impl Serialize) -> io::Result<()> {
    write_frame(output, &serde_json::to_vec(value)?)
}

#[cfg(windows)]
#[allow(unsafe_code, reason = "Windows job object calls")]
mod job {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOB_OBJECT_LIMIT_PROCESS_MEMORY, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation, SetInformationJobObject,
    };

    /// Ends its process when closed, as when this process ends.
    pub(super) struct Job(HANDLE);

    // SAFETY: a job handle may be used and closed from any thread.
    unsafe impl Send for Job {}

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: the handle is this value's own, closed once.
            unsafe { CloseHandle(self.0) };
        }
    }

    /// `child` in a job that holds it to `memory` bytes of committed memory and keeps a crash from showing an error box.
    /// `None` when that could not be set up: then only the time limit holds.
    pub(super) fn limit(child: &Child, memory: usize) -> Option<Job> {
        // SAFETY: null attributes and name are allowed; a zeroed limit struct is valid, and it outlives the call that reads its
        // size; `child` is borrowed, so its handle is open.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                log::warn!("no job object for a PDF worker: {}", std::io::Error::last_os_error());
                return None;
            }
            let job = Job(job);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
            limits.ProcessMemoryLimit = memory;
            let size = size_of_val(&limits) as u32;
            if SetInformationJobObject(job.0, JobObjectExtendedLimitInformation, (&raw const limits).cast(), size) == 0
                || AssignProcessToJobObject(job.0, child.as_raw_handle() as HANDLE) == 0
            {
                log::warn!("limiting a PDF worker: {}", std::io::Error::last_os_error());
                return None;
            }
            Some(job)
        }
    }

    #[cfg(test)]
    impl Job {
        /// The most memory its process has committed.
        pub(super) fn peak(&self) -> usize {
            use windows_sys::Win32::System::JobObjects::QueryInformationJobObject;
            // SAFETY: a zeroed limit struct is valid, and it outlives the call that writes it; the handle is open.
            unsafe {
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                let size = size_of_val(&info) as u32;
                assert_ne!(QueryInformationJobObject(self.0, JobObjectExtendedLimitInformation, (&raw mut info).cast(), size, std::ptr::null_mut()), 0);
                info.PeakProcessMemoryUsed
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::ArticleIr;
    use crate::pdf::tests::{name, pdf, quorum};
    use crate::pdf::{Figures, Region};
    use pdf_extract::{Dictionary, Document, Object, Stream};

    /// Room for the test run and a small PDF, but not for what the PDFs below ask.
    const SMALL: usize = 128 << 20;
    const AMPLE: Duration = Duration::from_secs(120);

    /// This test run, started on `serves`.
    fn worker(memory: usize, time: Duration) -> Worker {
        Worker { program: std::env::current_exe().unwrap(), args: ["--exact", "pdf_worker::tests::serves"].map(OsString::from).to_vec(), memory, time }
    }

    #[test]
    fn serves() {
        if std::env::var_os(WORKER).is_some() {
            init();
        }
    }

    /// Set in a test run started to stand for a binary that calls `init`.
    const STARTS: &str = "LATTICE_PDF_WORKER_TEST_STARTS";

    #[test]
    fn init_has_this_program_read_pdfs_in_workers() {
        if std::env::var_os(STARTS).is_none() {
            let me = ["--exact", "pdf_worker::tests::init_has_this_program_read_pdfs_in_workers"];
            let run = Command::new(std::env::current_exe().unwrap()).args(me).env(STARTS, "1").output().unwrap();
            let out = String::from_utf8_lossy(&run.stdout);
            assert!(out.contains("test result: ok. 1 passed"), "{out}");
            return;
        }
        init();
        assert_eq!(this().map(|w| &w.program), Some(&std::env::current_exe().unwrap()));
    }

    fn ir(worker: &Worker, bytes: &[u8]) -> Result<ArticleIr, String> {
        worker.ask(&Request::Ir { fallback: Some("Quorum".into()) }, bytes)
    }

    #[test]
    fn a_frame_is_taken_only_whole_and_within_its_limit() {
        let frame = |len: u64, body: &[u8]| [&len.to_le_bytes()[..], body].concat();
        let read = |bytes: Vec<u8>, max| read_frame(&mut &bytes[..], max).map_err(|e| e.kind());
        assert_eq!(read(frame(3, b"abc"), 3), Ok(b"abc".to_vec()));
        assert_eq!(read(frame(3, b"ab"), 3), Err(io::ErrorKind::UnexpectedEof), "cut short, as by a worker that was ended");
        assert_eq!(read(frame(4, b"abcd"), 3), Err(io::ErrorKind::InvalidData), "longer than the reader takes");
        assert_eq!(read(frame(u64::MAX, b"abc"), usize::MAX), Err(io::ErrorKind::UnexpectedEof), "not allocated by what the length says");
    }

    #[test]
    fn a_pdf_reads_in_a_worker_as_it_does_here() {
        let (worker, bytes) = (worker(SMALL, AMPLE), quorum());
        // Raised and lowered runs, and a heading: what quorum's regions leave empty. The viewer reads the script by name.
        let scripts = pdf(
            &[vec![
                (72., 100., 10., "Each replica grants a lease at lease e"),
                (236., 96.4, 7., "grant"),
                (236., 103., 7., "i,r"),
                (254., 100., 10., ", after it"),
                (72., 112., 10., "receives a lease request from the leader of it."),
            ]],
            None,
        );
        let heading = pdf(
            &[vec![
                (72., 100., 10.5, "A long line of body text that runs across the whole of the column and on to its end,"),
                (72., 112.6, 10.5, "with a second line that is nearly as long as the first one and then comes to a stop."),
                (72., 138., 11.6, "Logical (row-based) log replication"),
                (72., 155., 10.5, "Another way is to use different log formats for replication and for the storage engine,"),
                (72., 167.6, 10.5, "which allows the log to be decoupled from the internals of the storage engine."),
            ]],
            None,
        );
        let json = |r: Vec<Region>| serde_json::to_value(r).unwrap();
        for (file, holds) in [(&bytes, r#""runs":"#), (&scripts, r#""script":"sup""#), (&heading, r#""level":2"#)] {
            assert_eq!(ir(&worker, file), crate::pdf::to_ir(file, Some("Quorum")));
            let here = json(crate::pdf::regions(file).unwrap());
            assert!(here.to_string().contains(holds), "{here}");
            let there: Result<Vec<Region>, String> = worker.ask(&Request::Regions, file);
            assert_eq!(json(there.unwrap()), here);
        }
        let here = crate::pdf::to_ir(&bytes, Some("Quorum"));
        assert_eq!(ir(&worker, b"not a pdf"), crate::pdf::to_ir(b"not a pdf", Some("Quorum")), "an error comes back as it is");
        let mut srcs: Vec<String> = here.unwrap().blocks.into_iter().filter_map(|b| b.attrs.src).collect();
        // Not figures of it: an object this PDF does not have, which only the worker can tell, and a src of no PDF.
        srcs.extend([format!("{}/9999.0", srcs[0].rsplit_once('/').unwrap().0), "pdf-figure:12.0".to_owned()]);
        let (there, here) = (Figures::read_by(Some(&worker), &bytes).unwrap(), Figures::read_by(None, &bytes).unwrap());
        assert!(there.image(&srcs[0]).unwrap().is_some());
        for src in &srcs {
            assert_eq!(there.image(src), here.image(src), "{src}");
        }
    }

    /// Set in a test run started to stand for a binary that has called `init`.
    const INITIALISED: &str = "LATTICE_PDF_WORKER_TEST_INIT";

    #[test]
    fn a_process_that_called_init_reads_no_pdf_itself() {
        let Some(how) = std::env::var_os(INITIALISED) else {
            for how in ["does not start", "is ended"] {
                let me = ["--exact", "pdf_worker::tests::a_process_that_called_init_reads_no_pdf_itself"];
                let run = Command::new(std::env::current_exe().unwrap()).args(me).env(INITIALISED, how).output().unwrap();
                let out = String::from_utf8_lossy(&run.stdout);
                assert!(out.contains("test result: ok. 1 passed"), "a worker that {how}: {out}");
            }
            return;
        };
        // Imported while this process still reads PDFs itself.
        let bytes = quorum();
        let store = crate::store::Store::open_in_memory().unwrap();
        let id = crate::pdf::import(&store, &bytes, None).unwrap();
        // A worker that does not start, or one that is ended at its first answer: what reads the PDF here would read it.
        if how == "does not start" {
            assert!(THIS.set(Worker { program: "no such program".into(), args: Vec::new(), memory: SMALL, time: AMPLE }).is_ok());
            assert_eq!(crate::pdf::to_ir(&bytes, None), Err(msg!("pdf.parseFailed")));
            assert_eq!(crate::pdf::regions(&bytes).err(), Some(msg!("pdf.parseFailed")));
            assert!(Figures::parse(&bytes).is_err());
        } else {
            assert!(THIS.set(worker(SMALL, Duration::ZERO)).is_ok());
            assert_eq!(crate::pdf::to_ir(&bytes, None), Err(msg!("pdf.tooSlow", minutes = 0)));
            assert_eq!(crate::pdf::regions(&bytes).err(), Some(msg!("pdf.tooSlow", minutes = 0)));
        }
        // The figures are left for a later try, not recorded as ones the PDF lacks.
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        assert!(runtime.block_on(crate::images::run(&store, &crate::fetch::client(), id)).is_err());
        let recorded: i64 = store.conn().query_row("SELECT count(*) FROM article_images WHERE article_id = ?1", [id], |r| r.get(0)).unwrap();
        assert_eq!(recorded, 0);
    }

    #[test]
    fn figures_wait_for_a_worker_that_does_not_start() {
        let missing = Worker { program: "no such program".into(), args: Vec::new(), memory: SMALL, time: AMPLE };
        assert_eq!(Figures::read_by(Some(&missing), &quorum()).err(), Some(msg!("pdf.parseFailed")), "not a PDF without figures");
    }

    #[test]
    fn figures_wait_for_a_worker_that_has_ended() {
        let bytes = quorum();
        let src = crate::pdf::to_ir(&bytes, None).unwrap().blocks[1].attrs.src.clone().unwrap();
        // No time to answer in: the worker is ended at the first figure.
        let figures = Figures::read_by(Some(&worker(SMALL, Duration::ZERO)), &bytes).unwrap();
        assert_eq!(figures.image(&src), Err(msg!("pdf.tooSlow", minutes = 0)), "not a figure the PDF lacks");
        assert_eq!(figures.image(&src), Err(msg!("pdf.parseFailed")), "nor are the ones after it");
    }

    /// A zlib stream of `n` spaces and then `tail`, compressed as they are read so the spaces are never held.
    fn spaces(n: usize, tail: &[u8]) -> Vec<u8> {
        let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
        io::copy(&mut io::repeat(b' ').take(n as u64).chain(tail), &mut z).unwrap();
        z.finish().unwrap()
    }

    fn flate(content: Vec<u8>) -> Stream {
        let mut dict = Dictionary::new();
        dict.set("Filter", name("FlateDecode"));
        Stream::new(dict, content)
    }

    fn edited(bytes: &[u8], edit: impl FnOnce(&mut Document)) -> Vec<u8> {
        let mut doc = Document::load_mem(bytes).unwrap();
        edit(&mut doc);
        let mut out = Vec::new();
        doc.save_to(&mut out).unwrap();
        out
    }

    /// `bytes` with `body` as one more object, in an update at the end as an editor writes one.
    fn appended(bytes: &[u8], body: &[u8]) -> Vec<u8> {
        let doc = Document::load_mem(bytes).unwrap();
        let (id, root) = (doc.max_id + 1, doc.trailer.get(b"Root").and_then(Object::as_reference).unwrap());
        let mut out = bytes.to_vec();
        let at = out.len();
        out.extend([format!("{id} 0 obj\n").as_bytes(), body, b"\nendobj\n"].concat());
        let xref = out.len();
        out.extend(format!("xref\n{id} 1\n{at:010} 00000 n \ntrailer\n<</Size {} /Root {} 0 R /Prev {}>>\n", id + 1, root.0, doc.xref_start).as_bytes());
        out.extend(format!("startxref\n{xref}\n%%EOF\n").as_bytes());
        out
    }

    /// Each page draws what `before` gives in place of its own content, which it is passed.
    fn drawn_after(bytes: &[u8], before: impl Fn(&mut Document, Object) -> Object) -> Vec<u8> {
        edited(bytes, |doc| {
            for page in doc.get_pages().into_values().collect::<Vec<_>>() {
                let own = doc.get_dictionary(page).unwrap().get(b"Contents").unwrap().clone();
                let contents = before(doc, own);
                doc.get_dictionary_mut(page).unwrap().set("Contents", contents);
            }
        })
    }

    /// The PDFs below are sized so that a worker without its limits would get through them, and read the PDF: a few
    /// hundred megabytes of memory, a minute or two.
    const QUARTER_GIGABYTE: usize = 256 << 20;
    const MEGABYTE: usize = 1 << 20;

    /// `bytes` end `worker` by its memory limit: not a reply that the PDF failed (a guard, a panic), but none, from a worker
    /// that had committed close to the limit.
    fn exhausts(worker: &Worker, bytes: &[u8]) {
        let mut session = worker.start(&Request::Ir { fallback: None }, bytes).unwrap();
        assert_eq!(session.reply::<Result<ArticleIr, String>>(), Err(msg!("pdf.parseFailed")));
        #[cfg(windows)]
        assert!(session.peak() > SMALL / 2, "{} MiB", session.peak() >> 20);
    }

    #[test]
    fn a_flate_bomb_is_stopped_by_the_worker_s_memory_limit() {
        let worker = worker(SMALL, AMPLE);
        let bomb = spaces(QUARTER_GIGABYTE, b"");
        // In a page's content, which lopdf inflates for pdf-extract.
        let content = drawn_after(&quorum(), |doc, own| Object::Array(vec![Object::Reference(doc.add_object(flate(bomb.clone()))), own]));
        exhausts(&worker, &content);
        // In an object stream, which lopdf inflates as it loads the PDF, for the text and for the figures. lopdf leaves object
        // streams out of what it saves, so this one is added after. std reports the memory the limit refuses as a failed
        // read, and lopdf goes on without the rest of the stream: the worker reads the PDF, in what this process would have
        // grown past.
        let header = format!("<</Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length {}>>\nstream\n", bomb.len());
        let loaded = appended(&quorum(), &[header.as_bytes(), &bomb, b"\nendstream"].concat());
        let mut session = worker.start(&Request::Ir { fallback: Some("Quorum".into()) }, &loaded).unwrap();
        let read: ArticleIr = session.reply::<Result<_, String>>().unwrap().unwrap();
        #[cfg(windows)]
        assert!(session.peak() < SMALL);
        let text = |ir: &ArticleIr| ir.blocks.iter().map(|b| (b.kind.clone(), b.text.clone())).collect::<Vec<_>>();
        assert_eq!(text(&read), text(&crate::pdf::to_ir(&quorum(), None).unwrap()));
        let src = read.blocks[1].attrs.src.clone().unwrap();
        assert!(Figures::read_by(Some(&worker), &loaded).unwrap().image(&src).unwrap().is_some());
    }

    #[test]
    fn a_colour_profile_copied_on_every_q_fails_in_the_worker() {
        // pdf-extract copies the colour state, and this megabyte profile with it, on each of 300 `q`s.
        let bytes = drawn_after(&quorum(), |doc, own| {
            let mut profile = flate(spaces(MEGABYTE, b""));
            profile.dict.set("N", Object::Integer(3));
            let profile = doc.add_object(profile);
            let mut spaces = Dictionary::new();
            spaces.set("C", Object::Array(vec![name("ICCBased"), Object::Reference(profile)]));
            let page = *doc.get_pages().values().next().unwrap();
            let resources = doc.get_dictionary_mut(page).unwrap().get_mut(b"Resources").and_then(Object::as_dict_mut).unwrap();
            resources.set("ColorSpace", Object::Dictionary(spaces));
            let qs = doc.add_object(Stream::new(Dictionary::new(), format!("/C cs {}", "q ".repeat(300)).into_bytes()));
            Object::Array(vec![Object::Reference(qs), own])
        });
        exhausts(&worker(SMALL, AMPLE), &bytes);
    }

    #[test]
    fn a_content_listed_over_and_over_fails_in_the_worker() {
        // A megabyte, 300 times, which lopdf joins into one content.
        let bytes = drawn_after(&quorum(), |doc, own| {
            let content = Object::Reference(doc.add_object(flate(spaces(MEGABYTE, b""))));
            Object::Array(std::iter::repeat_n(content, 300).chain([own]).collect())
        });
        exhausts(&worker(SMALL, AMPLE), &bytes);
    }

    /// A megabyte of content that 1,000 pages draw: a gigabyte to read, for each pass over the pages.
    fn many_pages() -> Vec<u8> {
        edited(&pdf(&vec![vec![]; 1000], None), |doc| {
            let content = Object::Reference(doc.add_object(flate(spaces(MEGABYTE, b"BT /F1 10 Tf 72 100 Td (Over and over) Tj ET"))));
            for page in doc.get_pages().into_values().collect::<Vec<_>>() {
                doc.get_dictionary_mut(page).unwrap().set("Contents", content.clone());
            }
        })
    }

    #[test]
    fn many_pages_drawing_one_content_take_too_long_in_the_worker() {
        assert_eq!(ir(&worker(SMALL, Duration::from_secs(5)), &many_pages()), Err(msg!("pdf.tooSlow", minutes = 1)));
    }

    /// Set, to a file for the worker's id, in a test run started to stand for an app that ends while its worker reads.
    const PARENT: &str = "LATTICE_PDF_WORKER_TEST_PARENT";

    #[cfg(windows)]
    #[test]
    fn a_worker_ends_with_the_process_that_started_it() {
        if let Some(file) = std::env::var_os(PARENT) {
            let session = worker(SMALL, AMPLE).start(&Request::Ir { fallback: None }, &many_pages()).unwrap();
            std::fs::write(file, session.child.id().to_string()).unwrap();
            // Without dropping the session, as an app that crashes.
            std::process::exit(0);
        }
        let file = std::env::temp_dir().join(format!("lattice-pdf-worker-{}", std::process::id()));
        // Its output goes nowhere: the worker would be handed a pipe from it as well, and waiting for that pipe to close
        // would wait for the worker.
        let me = ["--exact", "pdf_worker::tests::a_worker_ends_with_the_process_that_started_it"];
        let parent = Command::new(std::env::current_exe().unwrap()).args(me).env(PARENT, &file).stdout(Stdio::null()).stderr(Stdio::null()).status();
        assert!(parent.unwrap().success());
        let pid = std::fs::read_to_string(&file).unwrap();
        let _ = std::fs::remove_file(&file);
        // By its name as well: once the worker has ended, its id may be another process's.
        let name = std::env::current_exe().unwrap().file_name().unwrap().to_string_lossy().into_owned();
        let only =
            |tool: &str, flag: &str| Command::new(tool).args([flag, "/FI", &format!("PID eq {pid}"), "/FI", &format!("IMAGENAME eq {name}")]).output().unwrap();
        let gone = (0..50).any(|_| {
            std::thread::sleep(Duration::from_millis(100));
            !String::from_utf8_lossy(&only("tasklist", "/NH").stdout).contains(pid.as_str())
        });
        if !gone {
            only("taskkill", "/F");
        }
        assert!(gone, "worker {pid} is still running");
    }
}
