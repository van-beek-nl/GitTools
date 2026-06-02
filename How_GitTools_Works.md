# How GitTools Works

*A plain-language guide to what GitTools does with your library and your Git
repository — and why it does it that way.*

This guide is for everyday users. You do **not** need to be a Git expert to read
it. Where a deeper Git idea is useful, it is explained in a short aside, and
pointers to the full technical design are collected at the end under
[Going Deeper](#going-deeper). If you are brand new to Git, start with the
[Git in one minute](#git-in-one-minute) box below.

---

## The problem GitTools solves

An Omnis library (`.lbs`) is a **binary** file. That is great for Omnis, but it
is a problem for Git:

- Git is built for **text**. It can show you a readable history of *what changed*,
  let two people work at once and combine their work, and let you review changes
  before accepting them.
- With a binary file, Git can only say "this file changed" — it cannot show *what*
  changed inside it, and it cannot merge two people's edits. If you and a
  colleague both change the library, one of you simply overwrites the other.

GitTools bridges that gap. It turns your binary library into a folder of **text
files** that Git understands, and turns those text files back into a working
binary library when you need one.

- **Export** = take your binary library and write it out as text (a folder of
  `.json` and `.omh` files — your "source").
- **Import** = take that text source and rebuild a binary library you can open in
  Omnis.

Everything else GitTools does is in service of doing those two things *safely*,
so that nobody's work is silently lost.

> ### Git in one minute
> If Git is new to you, here are the only ideas you need for this guide:
> - A **repository** ("repo") is a folder whose history Git tracks.
> - A **commit** is a saved snapshot of that folder at a moment in time.
> - **Pushing** shares your commits with your team; **pulling** brings theirs to
>   you.
> - A **merge** combines two sets of changes. A **conflict** is when two people
>   changed the *same thing* and Git needs a human to decide what to keep.
>
> GitTools takes care of the awkward part — turning your library into something
> Git can handle — and leans on your normal Git tools for the rest.

---

## The three versions GitTools keeps in step

Here is the key idea. At any moment there are really **three** versions of your
library's source floating around, and they can drift apart:

1. **Your binary library** — the `.lbs` you actually work in inside Omnis.
2. **Your local source** — the text export of that library, sitting in your repo
   on your machine.
3. **Everyone else's source** — what your teammates have pushed to the shared
   repository.

When you work alone and tidily, all three say the same thing and life is simple.
But the moment you pull a colleague's changes, or edit the library in Omnis
without exporting, or export without committing, two or three of these can
disagree.

GitTools' whole job is to keep these in agreement — and, when they disagree, to
**combine** them carefully instead of letting one blindly overwrite another.

---

## The trick: remembering the "last agreed version"

To combine changes sensibly, GitTools needs a reference point: *what did the
library and the source last agree on?* It remembers that point — call it the
**base** — every time you successfully export or import.

Think of the base as **the last photo you and a colleague both agreed was
correct.** Later, you each scribble on your own copy of that photo. To merge the
scribbles, you don't compare your copy to their copy directly — you compare each
of them *back to the original photo*. That tells you who changed what, so the
changes can be combined without losing either person's work. (Git people call
this a **three-way merge**: base, your side, their side.)

This is why GitTools can do the right thing when, say, you added a method while a
colleague renamed a different one: it sees that those are two independent changes
against the same base, and keeps both.

---

## What happens when you export

When you export a library, GitTools does roughly this:

1. **Checks the coast is clear.** If your source folder already has unresolved
   merge conflicts from earlier, GitTools stops and asks you to sort those out
   first — it won't pile new changes on top of a mess.
2. **Exports the library to a private scratch area first.** Your real source
   folder is *not* touched yet. Working in a scratch copy means that if anything
   goes wrong, your real files are untouched.
3. **Compares three things:** the base (last agreed version), your current source
   in the repo, and the fresh export from Omnis.
   - If your source hasn't moved since the base, the new export is simply written
     out. Done.
   - If your source *has* moved (for example you pulled a teammate's work), it
     **merges** the two using the base as the reference point.
4. **Writes the result into your source folder** — and that's it. The changes now
   sit in your working folder exactly as if you had edited the files by hand. You
   review and **commit them with your normal Git tools**, just like any other
   change.

Notice what GitTools does **not** do: it does not create commits for you, it does
not move you to a different branch, and it does not touch any files outside your
library's source folder. The export shows up as ordinary, reviewable changes.

> **Why a scratch area and a merge instead of just overwriting?**
> Because overwriting is how work gets lost. If GitTools just dumped the export
> over your source, a colleague's change that you had pulled in would vanish
> without warning. Merging against the base keeps both sides.

---

## What happens when you import

Importing is the reverse trip — turning source back into a working library:

1. GitTools checks your source folder has no unresolved conflicts.
2. It rebuilds a fresh binary library from the source and puts it in place
   (keeping a backup of the previous one along the way).
3. It records the source it just imported as the **new base** — because at this
   moment your library and your source genuinely agree.

A common, healthy rhythm is: **pull** your teammates' latest source, **import**
to get a library that matches it, do your work, then **export** and **commit**.

---

## When there's a conflict

Sometimes you and a teammate change the *same* method or property in
incompatible ways. No tool can guess whose version is right, so GitTools does the
honest thing: it leaves a **normal Git conflict** in your source folder and steps
back.

This is deliberately the *same* kind of conflict your editor or Git client
already knows how to show and resolve — you'll see the familiar conflict markers
and "resolve" options. There's nothing GitTools-specific to learn. Resolve it the
way you'd resolve any merge conflict, and carry on.

A conflict is **not** a failure or lost work. Both sides are preserved; you're
just being asked to make a judgement call that only a human can make.

> **A small honest caveat.** If you resolve a conflict by taking the incoming
> side wholesale (throwing away your library's version entirely), the same
> conflict can reappear on your next export. That's intentional: GitTools would
> rather show you the same conflict twice than quietly discard a change your
> library still contains. Importing the resolved source, or making any real edit,
> settles it.

---

## Where GitTools keeps its notes (and why you won't trip over them)

GitTools needs somewhere to remember the base and a little bookkeeping. It keeps
all of that **tucked away inside the repository's hidden `.git` folder**, not
among your project files. Two consequences for you:

- **Your project stays clean.** No stray metadata files appear next to your
  source, and GitTools never adds commits to your branches or moves you around.
  Its history is private and out of your way.
- **Its notes are safe.** GitTools stores them using Git's own durable
  bookkeeping, so Git's routine housekeeping (which cleans up things nothing
  points to) won't throw them away.

You normally never need to look at any of this. It's mentioned only so you know
that the "magic" is ordinary, contained, and reversible — not something editing
your files behind your back.

> **One library file per copy.** GitTools tracks its base **per library file**,
> not per source folder. That's on purpose: you might build several library files
> from one shared source and work in them separately, each at its own pace.
> GitTools keeps their states apart so they don't trample each other. (If you
> *move* a library file on disk, GitTools treats the moved file as fresh and
> re-establishes its base on the next export — harmless, and never destructive.)

---

## Why your work is safe

A few design choices are worth knowing because they're the reason GitTools is
hard to hurt yourself with:

- **Your real source is touched last.** Exports happen in a scratch area first;
  only a successful result is written into your folder.
- **The "agreed" state is saved as the very last step,** after everything else has
  succeeded. If an export is interrupted halfway, GitTools simply hasn't recorded
  the new state yet — the next export picks up cleanly and reproduces the work
  from your library. Nothing committed is lost.
- **It only ever touches your library's source folder.** Other files in your repo
  are normal Git files that GitTools leaves completely alone.
- **It won't silently overwrite committed work.** In the rare case where GitTools
  can't tell which direction a change should go (for example, a brand-new setup
  with no agreed base yet), it **warns you** before overwriting committed source
  and leaves the result uncommitted so you can review it.

---

## Good habits

- **Commit your exported source** soon after exporting, so your "local source" and
  your history stay in step.
- **Pull, then import** before starting a fresh chunk of work, so your library
  matches what the team has.
- **Resolve conflicts in your usual Git client** — they're standard Git conflicts.
- If GitTools ever **warns** about overwriting committed source, stop and read it;
  that warning only appears when your judgement is genuinely needed.

---

## How GitTools does it (a level deeper)

This section is for readers who are comfortable with Git (commits, branches,
merging, pushing/pulling, resolving conflicts) and with Omnis import/export, but
who haven't met the specific Git mechanisms GitTools uses. It explains *how* the
behaviours above are actually carried out — without going all the way down to the
implementation detail in the design spec.

### The building blocks

Three Git ideas do most of the work. You can use Git for years without meeting
them, because they sit one layer below everyday commands:

- **Objects: blobs and trees.** Git stores file *contents* as **blobs** and
  *folders* as **trees**, each addressed by a hash of what it contains. The
  consequence GitTools leans on: identical content always produces the *identical*
  hash. A commit, in fact, is just a tree plus some metadata (author, message,
  parent). GitTools works mostly with trees **directly**, without ever wrapping
  them in commits on your branches.
- **The index.** When you `git add`, you're filling the **index** — Git's staging
  area, the scratch list it uses to build the next tree. Git lets you point it at
  a *throwaway* index instead of the real one, so you can assemble trees without
  disturbing whatever you currently have staged.
- **Refs.** A **ref** is just a named pointer to a commit (your branches and tags
  are refs). You can create *private* refs that aren't branches, won't show up in
  normal Git usage, and won't be pushed.

These are exposed by Git's lower-level ("plumbing") commands, which let GitTools
do surgical things the everyday commands don't.

### Turning an export into something Git can compare

GitTools turns each version of the source into a single **tree** — Git's snapshot
of a folder — so that comparing two versions becomes as cheap as comparing two
hashes. It does this in a throwaway staging area, so your real one is never
touched.

The catch is that re-hashing *every* file on every export would be slow for a
large library. GitTools avoids that by leaning on the same incremental export
Omnis already does. Before the export, the temporary folder is seeded from the
last agreed version, and GitTools notes each file's size and timestamp. Omnis
then rewrites only the classes that changed. To build the tree, GitTools asks Git
which files have a different size or timestamp than before — a quick check that
doesn't involve reading their contents — and **only re-hashes those**. Unchanged
files keep the hash they already had. The result is the same tree it would have
produced by hashing everything, but the work is proportional to *what changed*,
not to the size of the library.

The same shortcut is used whenever GitTools needs to hash the **source already in
your repository** (for the comparisons below, and when importing): it asks Git
which files differ from what's already recorded, re-hashes only those, and takes
every unchanged file's hash straight from Git's records. So neither side of the
comparison ever re-reads your whole library.

One detail matters a lot here: GitTools hashes each changed file *as if it lived
at its real path in the repository*. That makes Git apply the same line-ending and
`.gitattributes` normalisation it uses for committed files. Without it, a file
that is identical apart from invisible line-ending normalisation would look
"changed" and produce **phantom conflicts** on files nobody actually edited.

### Detecting whether the source has moved

Because everything is a tree hash, the checks are simple comparisons:

- **Source unchanged since the base?** If your current source tree equals the base
  tree, nothing moved — GitTools just writes the new export out.
- **Source moved?** If they differ (typically because you pulled a teammate's
  work), GitTools merges.
- **Is this my own un-committed export?** GitTools remembers the last source tree
  it produced, so when you export twice before committing it recognises the live
  folder as its own output rather than treating it as a surprise.

### Doing the merge without disturbing anything

The three-way merge runs with `git merge-tree`, which takes the three tree hashes
— base, your source, the export — and computes a **result tree entirely in
memory**. It does not move `HEAD`, does not create a commit or branch, and does
not touch your working files or your index. A clean merge returns a result tree
(which GitTools writes into your source folder); a conflicting merge returns a
tree containing conflict markers plus a list of which files conflicted.

### Surfacing conflicts as normal Git conflicts

When the merge conflicts, GitTools writes the conflicted result into your source
folder and then stages the **unmerged versions** of the conflicted files into the
index — the base/yours/theirs entries that Git tracks during a conflict. That is
exactly the state an ordinary `git merge` leaves behind, which is *why* your
editor or Git client shows its usual unmerged-file conflict and offers its normal
resolve tools. There is nothing GitTools-specific to learn.

### Remembering the base so Git won't discard it

Each time a base is accepted, GitTools wraps that tree in a lightweight commit and
points a **private ref** at it (under `refs/gittools/…`):

- **Why a ref at all?** Git periodically garbage-collects objects that nothing
  points to. A tree mentioned only inside a metadata file would eventually be
  swept away; a ref is the "keep this" anchor that prevents it.
- **Why a commit, not just the bare tree?** Chaining one commit per accepted base
  gives a small private history you can inspect (a `git log` on that ref) for
  debugging — and because it's not a branch, it never appears in your normal
  history.

These operations never fire a post-commit hook and never move `HEAD`. (Earlier
versions of GitTools *did* move `HEAD` and relied on a hook to do their merges —
that was the source of past fragility. The current design avoids both.)

### Keeping its scratch work out of your way

- **Throwaway index.** All tree-building uses a temporary index file, so your real
  staged changes are never disturbed.
- **Scratch export folder.** Omnis exports into a temporary folder (seeded from the
  base so incremental exports stay fast), and your real source folder is only
  written once a good result exists. Temp folders and scratch indexes are always
  cleaned up, even if the export fails partway.

### Telling libraries apart

GitTools stores each library's notes under a **key derived from the library
file's own path** — a short hash of its canonical path, prefixed with the filename
so it's still recognisable. This is why two libraries that happen to share a name
in different folders never clash, and why a library's state follows the *file*
rather than the source folder (matching the one-library-per-copy idea above). If
you repoint a library's export location, GitTools notices that the stored base
describes the old location and resets to a fresh base rather than merging against
something unrelated.

### Making the "save" safe

The small file that records the agreed state is written by creating a temporary
file and then **atomically renaming** it over the previous one, so it can never be
left half-written. And it is written **last** — after the working folder and the
refs are already updated. If an export is interrupted before that final step, the
new state simply isn't recorded, and the next export redoes the work cleanly from
your library. That ordering is what makes interruptions harmless.

---

## Going deeper

If you'd like to understand the machinery underneath, the full technical design
lives in [GitTools_Import_Export_Redesign.md](GitTools_Import_Export_Redesign.md).
A few terms used there, in case you go looking:

- **Three-way merge / merge base** — the "last agreed version" idea, made precise.
  GitTools performs the merge entirely in memory with Git's `merge-tree`, so it
  never has to disturb your working files or your current branch.
- **Trees and refs** — the form GitTools' private notes take. The base is kept as
  a small private history (using `commit-tree` and refs under `refs/gittools/`),
  which is why Git's housekeeping won't discard it and why nothing shows up on
  your branches.
- **Why no commit hook** — earlier versions of GitTools installed a Git hook and
  juggled the repository's `HEAD` to do its merges; that was the source of past
  fragility. The current design needs neither, which is what makes it safe by
  construction.

You can use GitTools perfectly well without ever reading any of that — but it's
there if you're curious.
