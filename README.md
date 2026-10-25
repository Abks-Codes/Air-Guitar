Air Guitar

A browser-based air guitar that uses a webcam to track your hands. Curl a finger on your fretting hand (left) to choose a chord, then sweep your strumming hand (right) up or down to play it. 

Features

Webcam hand tracking with MediaPipe Tasks Vision.
Chord selection by finger gestures, including E, A, D, G, C, Am, Dm, Em, and Gm.
Up and down strum detection, with the movement angle selecting how many strings play.
Guitar WAV sample loading, with a synthesized fallback for missing notes.
Audio volume and strum sensitivity controls.


Requirements

A modern browser such as Chrome or Edge.
A webcam and permission to use it.
A local web server or HTTPS. Browsers generally block webcam access from pages opened directly as file://.
Internet access the first time the app runs, to load MediaPipe and its hand-tracking model from their configured URLs.


Run locally

Open the project folder in Visual Studio Code.
Install the Live Server extension if you do not already have a local web server.
Open the app's index.html file and choose Go Live (or use another local static web server).
In the browser, allow camera access.


Playing

Put both hands where the camera can see them.
Use the fretting hand(left) to curl a finger or supported finger combination to select a chord. The on-screen chord display shows the current selection.
Use the strumming hand(right) to sweep and play that chord.
