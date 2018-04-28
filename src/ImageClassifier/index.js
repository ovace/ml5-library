// Copyright (c) 2018 ml5
//
// This software is released under the MIT License.
// https://opensource.org/licenses/MIT

/*
Image classifier class
*/
/* eslint max-len: ["error", { "code": 180 }] */

import * as tf from '@tensorflow/tfjs';
import { IMAGENET_CLASSES } from './../utils/IMAGENET_CLASSES';
import { processVideo } from '../utils/imageUtilities';

const DEFAULTS = {
  learningRate: 0.0001,
  hiddenUnits: 100,
  epochs: 20,
  numClasses: 2,
  batchSize: 0.4,
};

class ImageClassifier {
  constructor(video, options = {}, callback = () => {}) {
    this.mobilenet = null;
    this.imageSize = 224;
    this.modelPath = 'https://storage.googleapis.com/tfjs-models/tfjs/mobilenet_v1_0.25_224/model.json';
    this.topKPredictions = 10;
    this.modelLoaded = false;
    this.video = null;
    this.waitingPredictions = [];

    // Props for retraining mobilenet
    this.hasAnyTrainedClass = false;
    this.customModel = null;
    this.epochs = options.epochs || DEFAULTS.epochs;
    this.hiddenUnits = options.hiddenUnits || DEFAULTS.hiddenUnits;
    this.numClasses = options.numClasses || DEFAULTS.numClasses;
    this.learningRate = options.learningRate || DEFAULTS.learningRate;
    this.batchSize = options.batchSize || DEFAULTS.batchSize;
    this.isPredicting = false;

    if (video instanceof HTMLVideoElement) {
      this.video = processVideo(video, this.imageSize);
    }

    this.loadModel().then((net) => {
      this.modelLoaded = true;
      this.mobilenetModified = net;
      this.waitingPredictions.forEach(i => this.predict(i.imgToPredict, i.num, i.callback));
      callback();
    });
  }

  async loadModel() {
    this.mobilenet = await tf.loadModel(this.modelPath);
    const layer = this.mobilenet.getLayer('conv_pw_13_relu');

    if (this.video) {
      tf.tidy(() => this.mobilenet.predict(ImageClassifier.imgToTensor(this.video))); // Warm up
    }

    return tf.model({ inputs: this.mobilenet.inputs, outputs: layer.output });
  }

  // Add an image to retrain
  addImage(label, callback = () => {}, input = null) {
    if (this.modelLoaded) {
      tf.tidy(() => {
        let processedImg;

        if (input) {
          processedImg = ImageClassifier.imgToTensor(input);
        } else {
          processedImg = ImageClassifier.imgToTensor(this.video);
        }

        const prediction = this.mobilenetModified.predict(processedImg);

        const y = tf.tidy(() => tf.oneHot(tf.tensor1d([label]), this.numClasses));

        if (this.xs == null) {
          this.xs = tf.keep(prediction);
          this.ys = tf.keep(y);
          this.hasAnyTrainedClass = true;
        } else {
          const oldX = this.xs;
          this.xs = tf.keep(oldX.concat(prediction, 0));
          const oldY = this.ys;
          this.ys = tf.keep(oldY.concat(y, 0));
          oldX.dispose();
          oldY.dispose();
          y.dispose();
        }
      });

      callback();
    }
  }

  // Train
  async train(onProgress) {
    if (!this.hasAnyTrainedClass) {
      throw new Error('Add some examples before training!');
    }

    this.isPredicting = false;

    this.customModel = tf.sequential({
      layers: [
        tf.layers.flatten({ inputShape: [7, 7, 256] }),
        tf.layers.dense({
          units: this.hiddenUnits,
          activation: 'relu',
          kernelInitializer: 'varianceScaling',
          useBias: true,
        }),
        tf.layers.dense({
          units: this.numClasses,
          kernelInitializer: 'varianceScaling',
          useBias: false,
          activation: 'softmax',
        }),
      ],
    });

    const optimizer = tf.train.adam(this.learningRate);
    this.customModel.compile({ optimizer, loss: 'categoricalCrossentropy' });
    const batchSize = Math.floor(this.xs.shape[0] * this.batchSize);
    if (!(batchSize > 0)) {
      throw new Error('Batch size is 0 or NaN. Please choose a non-zero fraction.');
    }

    this.customModel.fit(this.xs, this.ys, {
      batchSize,
      epochs: this.epochs,
      callbacks: {
        onBatchEnd: async (batch, logs) => {
          onProgress(logs.loss.toFixed(5));
          await tf.nextFrame();
        },
      },
    });
  }

  /* eslint consistent-return: 0 */
  async predict(inputOrNum, numOrCallback = null, cb = null) {
    let imgToPredict = numOrCallback;
    let numberOfClasses;
    let callback = cb;

    if (inputOrNum instanceof HTMLImageElement) {
      imgToPredict = inputOrNum;
    } else if (inputOrNum instanceof HTMLVideoElement) {
      if (!this.video) {
        this.video = processVideo(inputOrNum, this.imageSize);
      }
      imgToPredict = this.video;
    } else {
      imgToPredict = this.video;
      numberOfClasses = inputOrNum;
      callback = numOrCallback;
    }

    if (!this.modelLoaded) {
      this.waitingPredictions.push({ imgToPredict, num: numberOfClasses || this.topKPredictions, callback });
    } else {
      const logits = tf.tidy(() => {
        const pixels = tf.fromPixels(imgToPredict).toFloat();
        const resized = tf.image.resizeBilinear(pixels, [this.imageSize, this.imageSize]);
        const offset = tf.scalar(127.5);
        const normalized = resized.sub(offset).div(offset);
        const batched = normalized.reshape([1, this.imageSize, this.imageSize, 3]);
        return this.mobilenet.predict(batched);
      });

      const results = await ImageClassifier.getTopKClasses(logits, numberOfClasses || this.topKPredictions, callback);
      return results;
    }
  }

  // Static Method: get top k classes for mobilenet
  static async getTopKClasses(logits, topK, callback) {
    const values = await logits.data();
    const valuesAndIndices = [];
    for (let i = 0; i < values.length; i += 1) {
      valuesAndIndices.push({ value: values[i], index: i });
    }
    valuesAndIndices.sort((a, b) => b.value - a.value);
    const topkValues = new Float32Array(topK);

    const topkIndices = new Int32Array(topK);
    for (let i = 0; i < topK; i += 1) {
      topkValues[i] = valuesAndIndices[i].value;
      topkIndices[i] = valuesAndIndices[i].index;
    }
    const topClassesAndProbs = [];
    for (let i = 0; i < topkIndices.length; i += 1) {
      topClassesAndProbs.push({
        className: IMAGENET_CLASSES[topkIndices[i]],
        probability: topkValues[i],
      });
    }
    if (callback) {
      callback(topClassesAndProbs);
    }
    return topClassesAndProbs;
  }

  // Static Method: crop the image
  static cropImage(img) {
    const size = Math.min(img.shape[0], img.shape[1]);
    const centerHeight = img.shape[0] / 2;
    const beginHeight = centerHeight - (size / 2);
    const centerWidth = img.shape[1] / 2;
    const beginWidth = centerWidth - (size / 2);
    return img.slice([beginHeight, beginWidth, 0], [size, size, 3]);
  }

  // Static Method: image to tf tensor
  static imgToTensor(input) {
    return tf.tidy(() => {
      const img = tf.fromPixels(input);
      const croppedImage = ImageClassifier.cropImage(img);
      const batchedImage = croppedImage.expandDims(0);
      return batchedImage.toFloat().div(tf.scalar(127)).sub(tf.scalar(1));
    });
  }
}

export default ImageClassifier;
