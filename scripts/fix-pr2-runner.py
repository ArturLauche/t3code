from pathlib import Path

path = Path("scripts/pr2-final-source.py")
text = path.read_text()
old = '''    const githubEnvironment =
      Option.isSome(githubBroker) && (input.command === "git" || input.command === "gh")
        ? yield* (input.command === "gh"
            ? githubBroker.value.cliEnvironment
            : githubBroker.value.processEnvironment
          ).pipe('''
new = '''    const githubEnvironment =
      Option.isSome(githubBroker) && (input.command === "git" || input.command === "gh")
        ? yield* (
            input.command === "gh"
              ? githubBroker.value.cliEnvironment
              : githubBroker.value.processEnvironment
          ).pipe('''
if text.count(old) != 1:
    raise RuntimeError(f"VcsProcess expected-block patch count was {text.count(old)}")
path.write_text(text.replace(old, new, 1))
