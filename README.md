# FreeFEM language for VSCode

## Features

- Syntax highlighting for [FreeFEM](https://freefem.org)

<img src="img/membrane.png" width="70%">

- A command to run current FreeFEM file, accessible via command palette, editor menu or key binding `shift+cmd+r`. It parses the current file for number of MPI processes and parameters.

    Example for using `-wg -ns` flags and 4 MPI processes:

    ```c++
    // NBPROC 4
    // PARAM -wg -ns
    ```

## Release Notes

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT
