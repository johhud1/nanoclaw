{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  buildInputs = with pkgs; [
    nodejs_22
    python3  # For node-gyp native module compilation
    gcc
    gnumake
  ];

  shellHook = ''
    echo "NanoClaw development shell"
    echo "Node.js: $(node --version)"
    echo "npm: $(npm --version)"
  '';
}
