terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Recommended: store state remotely so it survives the box it was applied from.
  # backend "s3" {
  #   bucket = "ave-terraform-state"
  #   key    = "ave-ha/terraform.tfstate"
  #   region = "us-east-1"
  # }
}

provider "aws" {
  region = var.aws_region
}
