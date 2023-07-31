const path = require('path');
const HtmlWebPackPlugin = require('html-webpack-plugin');
const CopyPlugin = require("copy-webpack-plugin");

const srcDir = path.resolve(__dirname, 'src');
const outputDir = path.resolve(__dirname, '..', 'dist', 'frontend');

const main = {
  mode: 'development',
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
      {
        test: /\.(png|jpe?g|gif)$/i,
        type: 'asset/resource',
      },
    ],
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
  },
  entry: path.join(srcDir, 'index.ts'),
  output: {
    path: outputDir,
    filename: 'index.bundle.js',
  },
  devtool: 'inline-source-map',
  plugins: [
    new HtmlWebPackPlugin({
      title: 'Puppeteer Portal',
      template: path.join(srcDir, 'index.html'),
      hash: true,
      publicPath: './',
    }),
    new CopyPlugin({
      patterns: [
        "src/video-encoder.html"
      ],
    }),
  ],
};

module.exports = [main];
