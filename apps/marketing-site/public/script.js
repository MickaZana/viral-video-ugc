// Mobile nav toggle
const navToggle = document.getElementById("navToggle");
if (navToggle) {
  navToggle.addEventListener("click", () => {
    document.body.classList.toggle("nav-open");
  });
}

// Click-to-play for any ready video card (placeholder cards have no <video>, so this is a no-op for them)
document.querySelectorAll(".video-card[data-status='ready']").forEach((card) => {
  const media = card.querySelector(".video-card-media");
  const video = card.querySelector("video");
  const playBtn = card.querySelector(".play-btn");
  if (!media || !video || !playBtn) return;

  media.addEventListener("click", () => {
    if (video.paused) {
      video.muted = false;
      video.play();
      playBtn.style.display = "none";
    } else {
      video.pause();
      playBtn.style.display = "flex";
    }
  });

  video.addEventListener("ended", () => {
    playBtn.style.display = "flex";
  });
});

// Email capture — posts to this app's own /api/waitlist, which persists the
// submission locally (runs/waitlist.jsonl) and forwards it to WAITLIST_WEBHOOK_URL
// if one is configured (see .env.example).
const emailForm = document.getElementById("emailForm");
const emailNote = document.getElementById("emailNote");
if (emailForm) {
  emailForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = new FormData(emailForm).get("email");
    const submitBtn = emailForm.querySelector("button[type='submit']");
    const originalLabel = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.classList.add("btn-loading");
    submitBtn.textContent = "Submitting…";
    emailNote.textContent = "";
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email })
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        emailNote.textContent = body.error || "Something went wrong — try again.";
        return;
      }
      emailNote.textContent = `Thanks — we'll reach out to ${email} when your first cycle is ready.`;
      emailForm.reset();
    } catch {
      emailNote.textContent = "Something went wrong — try again.";
    } finally {
      submitBtn.disabled = false;
      submitBtn.classList.remove("btn-loading");
      submitBtn.textContent = originalLabel;
    }
  });
}
